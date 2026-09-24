#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

EXPECTED_AIONCORE_COMMIT = "47e66d0d151123e973b3fd1e77afcb5671b3f8c5"


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        fail(f"{label}: expected exactly one anchor, found {count}")
    return text.replace(old, new, 1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    root = args.source.resolve()

    head = subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()
    if head != EXPECTED_AIONCORE_COMMIT:
        fail(f"AionCore HEAD mismatch: expected {EXPECTED_AIONCORE_COMMIT}, got {head}")

    skill_file = root / "crates/aionui-extension/src/skill_service.rs"
    text = skill_file.read_text(encoding="utf-8")

    text = replace_once(
        text,
        'pub const BUILTIN_SKILLS_ENV_VAR: &str = "AIONUI_BUILTIN_SKILLS_PATH";\n',
        'pub const BUILTIN_SKILLS_ENV_VAR: &str = "AIONUI_BUILTIN_SKILLS_PATH";\n'
        '/// Immutable image-baked skills that take precedence over mutable user state.\n'
        'pub const MANAGED_SKILLS_ENV_VAR: &str = "AIONUI_MANAGED_SKILLS_DIR";\n',
        "managed env const",
    )

    old_list_repo = '''pub async fn list_available_skills_with_repo_for_user(
    paths: &SkillPaths,
    repo: &dyn ISkillRepository,
    user_id: &str,
) -> Result<Vec<SkillListItem>, ExtensionError> {
    list_skills_from_repo(paths, repo, user_id).await
}
'''
    new_list_repo = '''pub async fn list_available_skills_with_repo_for_user(
    paths: &SkillPaths,
    repo: &dyn ISkillRepository,
    user_id: &str,
) -> Result<Vec<SkillListItem>, ExtensionError> {
    let mut by_name = std::collections::HashMap::new();

    for item in list_skills_from_repo(paths, repo, user_id).await? {
        by_name.insert(item.name.clone(), item);
    }

    for item in list_managed_skills_from_env().await? {
        by_name.insert(item.name.clone(), item);
    }

    let mut items: Vec<SkillListItem> = by_name.into_values().collect();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}
'''
    text = replace_once(text, old_list_repo, new_list_repo, "repo list")

    start = text.find("async fn resolve_skill_source_path(paths: &SkillPaths, name: &str)")
    end_marker = "// ---------------------------------------------------------------------------\n// E. Scanning & discovery"
    end = text.find(end_marker, start)
    if start < 0 or end < 0:
        fail("managed resolver function bounds not found")

    new_resolvers = '''fn managed_skills_root_from_env() -> Option<PathBuf> {
    std::env::var(MANAGED_SKILLS_ENV_VAR)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

async fn canonical_managed_skills_root(root: &Path) -> Result<PathBuf, ExtensionError> {
    let canonical = tokio::fs::canonicalize(root).await?;
    if !canonical.is_dir() {
        return Err(ExtensionError::SkillNotFound(root.display().to_string()));
    }
    Ok(canonical)
}

async fn resolve_managed_skill_source_path_from_root(
    root: Option<&Path>,
    name: &str,
) -> Result<Option<PathBuf>, ExtensionError> {
    validate_filename(name)?;
    let Some(root) = root else {
        return Ok(None);
    };

    let canonical_root = canonical_managed_skills_root(root).await?;
    let candidate = canonical_root.join(name);
    let canonical_candidate = match tokio::fs::canonicalize(&candidate).await {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ExtensionError::Io(error)),
    };

    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(ExtensionError::PathTraversal(candidate.display().to_string()));
    }
    if !canonical_candidate.is_dir() || !canonical_candidate.join(SKILL_MANIFEST_FILE).is_file() {
        return Ok(None);
    }

    Ok(Some(canonical_candidate))
}

async fn resolve_managed_skill_source_path(name: &str) -> Result<Option<PathBuf>, ExtensionError> {
    let root = managed_skills_root_from_env();
    resolve_managed_skill_source_path_from_root(root.as_deref(), name).await
}

async fn list_managed_skills_from_env() -> Result<Vec<SkillListItem>, ExtensionError> {
    let Some(root) = managed_skills_root_from_env() else {
        return Ok(Vec::new());
    };
    let canonical_root = canonical_managed_skills_root(&root).await?;
    let mut items = Vec::new();

    for scanned in scan_skill_dirs(&canonical_root).await? {
        let Some(source_path) =
            resolve_managed_skill_source_path_from_root(Some(&canonical_root), &scanned.name).await?
        else {
            continue;
        };
        items.push(SkillListItem {
            name: scanned.name,
            description: scanned.description,
            location: source_path
                .join(SKILL_MANIFEST_FILE)
                .to_string_lossy()
                .into_owned(),
            relative_location: None,
            is_custom: false,
            source: SkillSource::Extension,
        });
    }

    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}

async fn resolve_skill_source_path(paths: &SkillPaths, name: &str) -> Result<Option<PathBuf>, ExtensionError> {
    if let Some(managed) = resolve_managed_skill_source_path(name).await? {
        return Ok(Some(managed));
    }

    let top = paths.builtin_skills_dir.join(name);
    if top.is_dir() {
        return Ok(Some(top));
    }
    let auto = paths.builtin_skills_dir.join(BUILTIN_AUTO_SKILLS_SUBDIR).join(name);
    if auto.is_dir() {
        return Ok(Some(auto));
    }
    let user = paths.user_skills_dir.join(name);
    if user.is_dir() {
        return Ok(Some(user));
    }
    Ok(None)
}

async fn resolve_skill_source_path_with_repo_for_user_from_managed_root(
    paths: &SkillPaths,
    repo: &dyn ISkillRepository,
    user_id: &str,
    name: &str,
    managed_root: Option<&Path>,
) -> Result<Option<PathBuf>, ExtensionError> {
    if let Some(managed) = resolve_managed_skill_source_path_from_root(managed_root, name).await? {
        return Ok(Some(managed));
    }

    if let Some(row) = repo.find_by_name_any_for_user(user_id, name).await? {
        let path = PathBuf::from(&row.path);
        if path.is_dir() {
            return Ok(Some(path));
        }
        warn!(
            skill = %name,
            path = %path.display(),
            deleted = row.deleted_at.is_some(),
            "skill row points at a missing directory"
        );
        if row.user_id.is_some() {
            return Ok(None);
        }
    }
    let top = paths.builtin_skills_dir.join(name);
    if top.is_dir() {
        return Ok(Some(top));
    }
    let auto = paths.builtin_skills_dir.join(BUILTIN_AUTO_SKILLS_SUBDIR).join(name);
    if auto.is_dir() {
        return Ok(Some(auto));
    }
    Ok(None)
}

async fn resolve_skill_source_path_with_repo_for_user(
    paths: &SkillPaths,
    repo: &dyn ISkillRepository,
    user_id: &str,
    name: &str,
) -> Result<Option<PathBuf>, ExtensionError> {
    let managed_root = managed_skills_root_from_env();
    resolve_skill_source_path_with_repo_for_user_from_managed_root(
        paths,
        repo,
        user_id,
        name,
        managed_root.as_deref(),
    )
    .await
}

'''
    text = text[:start] + new_resolvers + text[end:]

    test_module = '''

#[cfg(test)]
mod managed_skill_security_tests {
    use super::*;
    use aionui_db::{SqliteSkillRepository, UpsertSkillParams};

    fn write_skill(root: &Path, name: &str, body: &str) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(SKILL_MANIFEST_FILE),
            format!("---\\nname: {name}\\ndescription: managed test\\n---\\n{body}"),
        )
        .unwrap();
        dir
    }

    fn test_paths(base: &Path) -> SkillPaths {
        SkillPaths {
            data_dir: base.to_path_buf(),
            user_skills_dir: base.join("skills"),
            cron_skills_dir: base.join("cron-skills"),
            builtin_skills_dir: base.join("builtin-skills"),
            builtin_rules_dir: base.join("builtin-rules"),
            assistant_rules_dir: base.join("assistant-rules"),
            assistant_skills_dir: base.join("assistant-skills"),
        }
    }

    #[tokio::test]
    async fn managed_skill_wins_over_same_named_mutable_user_row() {
        let tmp = tempfile::TempDir::new().unwrap();
        let managed_root = tmp.path().join("managed");
        let mutable_root = tmp.path().join("mutable");
        let managed = write_skill(&managed_root, "ship-gate", "MANAGED");
        let mutable = write_skill(&mutable_root, "ship-gate", "MUTABLE");
        let mutable_path = mutable.to_string_lossy().into_owned();

        let db = aionui_db::init_database_memory().await.unwrap();
        let repo = SqliteSkillRepository::new(db.pool().clone());
        repo.upsert_for_user(
            DEFAULT_USER_ID,
            UpsertSkillParams {
                name: "ship-gate",
                description: Some("mutable"),
                path: &mutable_path,
                source: "user",
                enabled: true,
            },
        )
        .await
        .unwrap();

        let resolved = resolve_skill_source_path_with_repo_for_user_from_managed_root(
            &test_paths(tmp.path()),
            &repo,
            DEFAULT_USER_ID,
            "ship-gate",
            Some(&managed_root),
        )
        .await
        .unwrap();

        assert_eq!(resolved.unwrap(), managed.canonicalize().unwrap());
    }

    #[tokio::test]
    async fn non_managed_name_still_resolves_from_user_repo() {
        let tmp = tempfile::TempDir::new().unwrap();
        let managed_root = tmp.path().join("managed");
        std::fs::create_dir_all(&managed_root).unwrap();
        let mutable_root = tmp.path().join("mutable");
        let custom = write_skill(&mutable_root, "my-custom", "CUSTOM");
        let custom_path = custom.to_string_lossy().into_owned();

        let db = aionui_db::init_database_memory().await.unwrap();
        let repo = SqliteSkillRepository::new(db.pool().clone());
        repo.upsert_for_user(
            DEFAULT_USER_ID,
            UpsertSkillParams {
                name: "my-custom",
                description: Some("custom"),
                path: &custom_path,
                source: "user",
                enabled: true,
            },
        )
        .await
        .unwrap();

        let resolved = resolve_skill_source_path_with_repo_for_user_from_managed_root(
            &test_paths(tmp.path()),
            &repo,
            DEFAULT_USER_ID,
            "my-custom",
            Some(&managed_root),
        )
        .await
        .unwrap();

        assert_eq!(resolved.unwrap(), custom);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn managed_skill_symlink_escape_is_rejected() {
        let tmp = tempfile::TempDir::new().unwrap();
        let managed_root = tmp.path().join("managed");
        std::fs::create_dir_all(&managed_root).unwrap();
        let outside = tmp.path().join("outside");
        let outside_skill = write_skill(&outside, "evil", "EVIL");
        std::os::unix::fs::symlink(&outside_skill, managed_root.join("evil")).unwrap();

        let result =
            resolve_managed_skill_source_path_from_root(Some(&managed_root), "evil").await;

        assert!(matches!(result, Err(ExtensionError::PathTraversal(_))));
    }
}
'''
    if "mod managed_skill_security_tests" in text:
        fail("managed skill test module already present")
    text += test_module
    skill_file.write_text(text, encoding="utf-8")

    provisioning_file = root / "crates/aionui-team/src/provisioning.rs"
    ptext = provisioning_file.read_text(encoding="utf-8")

    role_mode_helper = r'''
fn managed_team_role_session_mode(
    assistant_id: Option<&str>,
) -> Result<Option<&'static str>, TeamError> {
    let Some(assistant_id) = assistant_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    if !assistant_id.starts_with("team-role:") {
        return Ok(None);
    }

    let specialty = assistant_id.rsplit(':').next().unwrap_or_default();
    match specialty {
        "architect" | "qa" | "security" | "reviewer" => Ok(Some("plan")),
        "pm" | "backend" | "frontend" | "fullstack" | "devops" => {
            Ok(Some("bypassPermissions"))
        }
        _ => Err(TeamError::InvalidRequest(format!(
            "unknown managed Team role assistant specialty: {assistant_id}"
        ))),
    }
}

'''
    ptext = replace_once(
        ptext,
        "use crate::types::{Team, TeamAgent, TeammateRole};\nuse crate::workspace::TeamWorkspaceResolver;\n\n",
        "use crate::types::{Team, TeamAgent, TeammateRole};\nuse crate::workspace::TeamWorkspaceResolver;\n\n"
        + role_mode_helper,
        "managed Team role mode helper",
    )

    ptext = replace_once(
        ptext,
        "        let mcp_selection = self\n"
        "            .resolve_assistant_mcp_selection(user_id, assistant_id.as_deref())\n"
        "            .await?;\n"
        "        let agent = self\n",
        "        let mcp_selection = self\n"
        "            .resolve_assistant_mcp_selection(user_id, assistant_id.as_deref())\n"
        "            .await?;\n"
        "        let role_session_mode = managed_team_role_session_mode(assistant_id.as_deref())?\n"
        "            .map(str::to_owned);\n"
        "        let agent = self\n",
        "add-agent role session seed",
    )

    ptext = replace_once(
        ptext,
        "        let mcp_selection = self\n"
        "            .resolve_assistant_mcp_selection(&req.user_id, req.assistant_id.as_deref())\n"
        "            .await?;\n"
        "        let agent = self\n",
        "        let mcp_selection = self\n"
        "            .resolve_assistant_mcp_selection(&req.user_id, req.assistant_id.as_deref())\n"
        "            .await?;\n"
        "        let role_session_mode = managed_team_role_session_mode(req.assistant_id.as_deref())?\n"
        "            .map(str::to_owned);\n"
        "        let agent = self\n",
        "spawn-agent role session seed",
    )

    old_seed = "                    session_mode: row.session_mode.clone(),\n"
    if ptext.count(old_seed) != 2:
        fail(
            "managed Team role session seed: expected exactly two anchors, "
            f"found {ptext.count(old_seed)}"
        )
    ptext = ptext.replace(
        old_seed,
        "                    session_mode: role_session_mode.or(row.session_mode.clone()),\n",
    )

    old_runtime_mode = (
        "        let session_mode = session_mode_for_backend(&agent.backend, agent_type, cli_metadata.as_ref());\n"
    )
    if ptext.count(old_runtime_mode) != 2:
        fail(
            "managed Team role attach mode: expected exactly two runtime mode anchors, "
            f"found {ptext.count(old_runtime_mode)}"
        )
    new_runtime_mode = (
        "        let session_mode = managed_team_role_session_mode(agent.assistant_id.as_deref())?\n"
        "            .map(str::to_owned)\n"
        "            .unwrap_or_else(|| session_mode_for_backend(&agent.backend, agent_type, cli_metadata.as_ref()));\n"
    )
    ptext = ptext.replace(old_runtime_mode, new_runtime_mode)

    role_mode_tests = r'''

#[cfg(test)]
mod managed_team_role_mode_tests {
    use super::*;

    #[test]
    fn restrictive_managed_roles_use_plan_mode() {
        for specialty in ["architect", "qa", "security", "reviewer"] {
            let id = format!("team-role:bare:claude:{specialty}");
            assert_eq!(
                managed_team_role_session_mode(Some(&id)).unwrap(),
                Some("plan")
            );
        }
    }

    #[test]
    fn execution_managed_roles_use_bypass_permissions() {
        for specialty in ["pm", "backend", "frontend", "fullstack", "devops"] {
            let id = format!("team-role:bare:claude:{specialty}");
            assert_eq!(
                managed_team_role_session_mode(Some(&id)).unwrap(),
                Some("bypassPermissions")
            );
        }
    }

    #[test]
    fn ordinary_assistants_are_not_reclassified() {
        assert_eq!(
            managed_team_role_session_mode(Some("bare:2d23ff1c")).unwrap(),
            None
        );
        assert_eq!(managed_team_role_session_mode(None).unwrap(), None);
    }

    #[test]
    fn unknown_managed_role_fails_closed() {
        let err =
            managed_team_role_session_mode(Some("team-role:bare:claude:unknown"))
                .unwrap_err();
        assert!(matches!(err, TeamError::InvalidRequest(_)));
    }
}
'''
    if "mod managed_team_role_mode_tests" in ptext:
        fail("managed Team role mode test module already present")
    ptext += role_mode_tests
    provisioning_file.write_text(ptext, encoding="utf-8")

    migration = root / "crates/aionui-db/migrations/044_managed_skill_hardening.sql"
    if migration.exists():
        fail("migration 044 already exists")
    migration.write_text(
        "-- HenrryVale AionUi managed-skill hardening.\n"
        "-- Claude argv mode consumes a mutable /data/session-skills plugin view.\n"
        "-- Use safe injected dual-channel delivery instead.\n"
        "UPDATE agent_metadata SET\n"
        "    skill_delivery = '{\"mode\":\"injected\"}',\n"
        "    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000\n"
        "WHERE backend = 'claude';\n",
        encoding="utf-8",
    )

    migration_test = root / "crates/aionui-db/tests/agent_skill_delivery_migration.rs"
    mtext = migration_test.read_text(encoding="utf-8")
    old_start = mtext.find("async fn claude_gets_layer_one_argv_delivery_with_allow_dir_args()")
    if old_start < 0:
        fail("claude migration test function not found")
    attr_start = mtext.rfind("#[tokio::test]", 0, old_start)
    next_doc = mtext.find("/// codebuddy is deliberately", old_start)
    if attr_start < 0 or next_doc < 0:
        fail("claude migration test bounds not found")
    new_test = '''#[tokio::test]
async fn claude_uses_injected_delivery_after_managed_skill_hardening() {
    let pool = migrated_pool().await;
    let delivery = delivery_json(&pool, "claude").await;

    assert_eq!(delivery["mode"], "injected");
    assert!(
        delivery.get("args").is_none(),
        "managed-skill hardening must not pass the mutable session-skills view"
    );
}

'''
    mtext = mtext[:attr_start] + new_test + mtext[next_doc:]
    migration_test.write_text(mtext, encoding="utf-8")

    # Direct-CLI Claude/Codex bypass AcpAgentManager and therefore never run
    # SessionNewPreludeHook. For injected delivery, compose the same managed
    # [Assistant Rules] + skills index at the factory boundary and carry it
    # through SessionInit.preset_context, which Claude maps to
    # --append-system-prompt.
    acp_factory_file = root / "crates/aionui-ai-agent/src/factory/acp.rs"
    atext = acp_factory_file.read_text(encoding="utf-8")

    router_bootstrap_anchor = "pub(super) async fn build(\n"
    router_bootstrap_helper = r'''
fn managed_team_router_bootstrap_required(
    belongs_to_team: bool,
    skills: &[String],
) -> bool {
    belongs_to_team && skills.iter().any(|name| name == "skill-design")
}

fn managed_skill_body(raw: &str) -> Result<&str, AgentError> {
    let Some(rest) = raw.strip_prefix("---\n") else {
        return Ok(raw);
    };

    let Some((_, body)) = rest.split_once("\n---\n") else {
        return Err(AgentError::internal(
            "managed Team router bootstrap found malformed skill-design frontmatter",
        ));
    };

    Ok(body)
}

fn inject_bootstrapped_skill(
    prefix: &str,
    skill_name: &str,
    skill_root: &str,
    body: &str,
) -> Result<String, AgentError> {
    const CLOSE_RULES: &str = "[/Assistant Rules]";

    let Some(close_at) = prefix.rfind(CLOSE_RULES) else {
        return Err(AgentError::internal(
            "managed Team router bootstrap requires an Assistant Rules block",
        ));
    };

    let mut out =
        String::with_capacity(prefix.len() + body.len() + skill_root.len() + 128);

    out.push_str(&prefix[..close_at]);
    out.push_str("\n\n## Bootstrapped Skill: ");
    out.push_str(skill_name);
    out.push_str(
        "\nSkill root (resolve every relative path in this body against it): "
    );
    out.push_str(skill_root);
    out.push_str("\n\n");
    out.push_str(body.trim());
    out.push('\n');
    out.push_str(CLOSE_RULES);
    out.push_str(&prefix[close_at + CLOSE_RULES.len()..]);

    Ok(out)
}

async fn bootstrap_managed_team_router_prefix(
    conversation_id: &str,
    belongs_to_team: bool,
    skills: &[String],
    skill_dirs: &[aionui_session::SkillDirSpec],
    prefix: Option<String>,
) -> Result<Option<String>, AgentError> {
    if !managed_team_router_bootstrap_required(belongs_to_team, skills) {
        return Ok(prefix);
    }

    let router_dirs: Vec<_> = skill_dirs
        .iter()
        .filter(|skill| skill.name == "skill-design")
        .collect();

    if router_dirs.len() != 1 {
        return Err(AgentError::internal(format!(
            "managed Team router bootstrap expected exactly one resolved skill-design source, found {}",
            router_dirs.len()
        )));
    }

    let router = router_dirs[0];
    let skill_file = std::path::Path::new(&router.path).join("SKILL.md");

    let raw = tokio::fs::read_to_string(&skill_file)
        .await
        .map_err(|error| {
            AgentError::internal(format!(
                "managed Team router bootstrap could not read skill-design: {error}"
            ))
        })?;

    let body = managed_skill_body(&raw)?;

    if body.trim().is_empty() {
        return Err(AgentError::internal(
            "managed Team router bootstrap resolved an empty skill-design body",
        ));
    }

    let prefix = prefix.ok_or_else(|| {
        AgentError::internal(
            "managed Team router bootstrap requires an injected Assistant Rules prefix",
        )
    })?;

    let bootstrapped =
        inject_bootstrapped_skill(&prefix, "skill-design", &router.path, body)?;

    tracing::info!(
        conversation_id,
        skill = "skill-design",
        source = %router.path,
        "managed Team router bootstrap injected full skill body"
    );

    Ok(Some(bootstrapped))
}
'''

    atext = replace_once(
        atext,
        router_bootstrap_anchor,
        router_bootstrap_helper + router_bootstrap_anchor,
        "managed Team router bootstrap helper",
    )


    old_direct_cli_delivery = """        let delivery = crate::factory::resolve_skill_delivery(
            deps.as_ref(),
            &ctx.user_id,
            &ctx.conversation_id,
            &config.skills,
            &meta,
        )
        .await;
        let instance = crate::session_agent::build_session_instance(
"""
    new_direct_cli_delivery = """        let mut delivery = crate::factory::resolve_skill_delivery(
            deps.as_ref(),
            &ctx.user_id,
            &ctx.conversation_id,
            &config.skills,
            &meta,
        )
        .await;

        // claude/codex on this route use SessionAgentTask, not AcpAgentManager,
        // so SessionNewPreludeHook never runs. Injected-mode vendors must get
        // the exact same composed rules + skill index through SessionInit.
        if matches!(
            &delivery.plan.mode,
            aionui_api_types::SkillDeliveryMode::Injected
        ) {
            let composed = crate::factory::compose_injected_prefix_for(
                deps.as_ref(),
                &ctx.user_id,
                config.preset_context.as_deref(),
                &config.skills,
                &delivery.plan.mode,
            )
            .await;

            delivery.injected_prefix =
                bootstrap_managed_team_router_prefix(
                    &ctx.conversation_id,
                    build_context.belongs_to_team,
                    &config.skills,
                    &delivery.skill_dirs,
                    composed,
                )
                .await?;
        }

        let instance = crate::session_agent::build_session_instance(
"""
    atext = replace_once(
        atext,
        old_direct_cli_delivery,
        new_direct_cli_delivery,
        "direct CLI managed injected prefix composition",
    )
    router_bootstrap_tests = r'''

#[cfg(test)]
mod managed_team_router_bootstrap_tests {
    use super::*;

    #[test]
    fn team_snapshot_with_skill_design_requires_router_bootstrap() {
        assert!(managed_team_router_bootstrap_required(
            true,
            &[
                "skill-design".to_owned(),
                "ux-heuristics".to_owned()
            ]
        ));
    }

    #[test]
    fn ordinary_conversation_does_not_bootstrap_router() {
        assert!(!managed_team_router_bootstrap_required(
            false,
            &["skill-design".to_owned()]
        ));
    }

    #[test]
    fn team_without_skill_design_does_not_bootstrap_router() {
        assert!(!managed_team_router_bootstrap_required(
            true,
            &["ship-gate".to_owned()]
        ));
    }

    #[tokio::test]
    async fn team_router_bootstrap_injects_full_skill_body() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("skill-design");

        std::fs::create_dir_all(&root).unwrap();

        std::fs::write(
            root.join("SKILL.md"),
            "---\nname: skill-design\ndescription: router\n---\nROUTER_BODY_MARKER",
        )
        .unwrap();

        let dirs = vec![aionui_session::SkillDirSpec {
            name: "skill-design".to_owned(),
            path: root.to_string_lossy().into_owned(),
        }];

        let result = bootstrap_managed_team_router_prefix(
            "conv-router-test",
            true,
            &["skill-design".to_owned()],
            &dirs,
            Some(
                "[Assistant Rules]\n## Available Skills\n- **skill-design**: router\n[/Assistant Rules]"
                    .to_owned(),
            ),
        )
        .await
        .unwrap()
        .unwrap();

        assert!(result.contains("## Bootstrapped Skill: skill-design"));
        assert!(result.contains("ROUTER_BODY_MARKER"));
        assert!(result.contains("Skill root"));
        assert!(result.ends_with("[/Assistant Rules]"));
    }

    #[tokio::test]
    async fn missing_router_source_fails_closed() {
        let error = bootstrap_managed_team_router_prefix(
            "conv-router-test",
            true,
            &["skill-design".to_owned()],
            &[],
            Some(
                "[Assistant Rules]\n[/Assistant Rules]".to_owned()
            ),
        )
        .await
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains(
                    "expected exactly one resolved skill-design source"
                )
        );
    }
}
'''

    if "mod managed_team_router_bootstrap_tests" in atext:
        fail("managed Team router bootstrap tests already present")

    atext += router_bootstrap_tests


    acp_factory_file.write_text(atext, encoding="utf-8")

    session_agent_file = root / "crates/aionui-ai-agent/src/session_agent.rs"
    stext = session_agent_file.read_text(encoding="utf-8")

    helper_anchor = """/// Open a claude/codex `SessionBackend` via the clean-slate connection and wrap it
"""
    helper = """fn direct_cli_preset_context(
    config: &AcpBuildExtra,
    skill_delivery: &crate::factory::ResolvedSkillDelivery,
) -> Option<String> {
    skill_delivery
        .injected_prefix
        .clone()
        .or_else(|| config.preset_context.clone())
}

"""
    stext = replace_once(
        stext,
        helper_anchor,
        helper + helper_anchor,
        "direct CLI preset context helper",
    )

    old_session_init = """    // GAP #4 — preset_context + skills carried into the init surface.
    let init = SessionInit {
        mcp_servers,
        skills: config.skills.clone(),
        preset_context: config.preset_context.clone(),
"""
    new_session_init = """    // GAP #4 — preset_context + skills carried into the init surface.
    // Injected-mode direct-CLI vendors do not run the ACP prompt pipeline, so
    // prefer the factory-composed managed rules/skill index. Non-injected
    // delivery preserves the original raw preset context.
    let init = SessionInit {
        mcp_servers,
        skills: config.skills.clone(),
        preset_context: direct_cli_preset_context(config, &skill_delivery),
"""
    stext = replace_once(
        stext,
        old_session_init,
        new_session_init,
        "direct CLI SessionInit managed preset",
    )

    direct_cli_tests = r"""

#[cfg(test)]
mod managed_direct_cli_skill_delivery_tests {
    use super::*;
    use crate::factory::ResolvedSkillDelivery;

    #[test]
    fn injected_managed_prefix_wins_over_raw_preset_for_direct_cli() {
        let config = AcpBuildExtra {
            preset_context: Some("RAW_ROLE_PROMPT".into()),
            ..Default::default()
        };
        let delivery = ResolvedSkillDelivery {
            injected_prefix: Some(
                "[Assistant Rules]\nROLE\n## Available Skills\n- **skill-design**: router\n[/Assistant Rules]"
                    .into(),
            ),
            ..Default::default()
        };

        let resolved = direct_cli_preset_context(&config, &delivery)
            .expect("injected managed prefix must be carried into SessionInit");

        assert!(resolved.contains("[Assistant Rules]"));
        assert!(resolved.contains("## Available Skills"));
        assert!(resolved.contains("skill-design"));
        assert_ne!(resolved, "RAW_ROLE_PROMPT");
    }

    #[test]
    fn direct_cli_without_injected_prefix_preserves_raw_preset() {
        let config = AcpBuildExtra {
            preset_context: Some("RAW_ROLE_PROMPT".into()),
            ..Default::default()
        };
        let delivery = ResolvedSkillDelivery::default();

        assert_eq!(
            direct_cli_preset_context(&config, &delivery).as_deref(),
            Some("RAW_ROLE_PROMPT")
        );
    }
}
"""
    if "mod managed_direct_cli_skill_delivery_tests" in stext:
        fail("managed direct CLI skill delivery tests already present")
    stext += direct_cli_tests
    # FIX-2B: carry the deterministic managed routing context into the direct
    # session task and render selected skill bodies before Command::Send.
    old_task_field = """    prompt_dump: Option<SessionPromptDump>,
}
"""
    new_task_field = """    prompt_dump: Option<SessionPromptDump>,
    /// Present only for a Team direct-CLI session whose managed skill-design
    /// bootstrap was proven at factory time.
    managed_team_routing: Option<crate::managed_team_routing::ManagedTeamRoutingContext>,
}
"""
    stext = replace_once(
        stext,
        old_task_field,
        new_task_field,
        "SessionAgentTask managed Team routing field",
    )

    old_simple_ctor_tail = """            // No broadcaster: this ctor is the test/simple path, which has no
            // conversation WebSocket to push a late usage frame to.
            None,
        )
    }
"""
    new_simple_ctor_tail = """            // No broadcaster: this ctor is the test/simple path, which has no
            // conversation WebSocket to push a late usage frame to.
            None,
            None,
        )
    }
"""
    stext = replace_once(
        stext,
        old_simple_ctor_tail,
        new_simple_ctor_tail,
        "simple SessionAgentTask routing default",
    )

    old_preload_tail = """            CatalogPreload::from_handshake(handshake),
            prompt_dump,
            broadcaster,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn build(
"""
    new_preload_tail = """            CatalogPreload::from_handshake(handshake),
            prompt_dump,
            broadcaster,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new_with_preload_and_managed_routing(
        agent_type: AgentType,
        conversation_id: String,
        user_id: String,
        workspace: String,
        backend: Arc<dyn SessionBackend>,
        session_repo: Option<Arc<dyn IAcpSessionRepository>>,
        handshake: &aionui_api_types::AgentHandshake,
        prompt_dump: Option<SessionPromptDump>,
        broadcaster: Option<Arc<dyn EventBroadcaster>>,
        managed_team_routing: Option<crate::managed_team_routing::ManagedTeamRoutingContext>,
    ) -> Arc<Self> {
        Self::build(
            agent_type,
            conversation_id,
            user_id,
            workspace,
            backend,
            session_repo,
            CatalogPreload::from_handshake(handshake),
            prompt_dump,
            broadcaster,
            managed_team_routing,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn build(
"""
    stext = replace_once(
        stext,
        old_preload_tail,
        new_preload_tail,
        "managed routing production constructor",
    )

    old_build_signature_tail = """        catalog_preload: CatalogPreload,
        prompt_dump: Option<SessionPromptDump>,
        broadcaster: Option<Arc<dyn EventBroadcaster>>,
    ) -> Arc<Self> {
"""
    new_build_signature_tail = """        catalog_preload: CatalogPreload,
        prompt_dump: Option<SessionPromptDump>,
        broadcaster: Option<Arc<dyn EventBroadcaster>>,
        managed_team_routing: Option<crate::managed_team_routing::ManagedTeamRoutingContext>,
    ) -> Arc<Self> {
"""
    stext = replace_once(
        stext,
        old_build_signature_tail,
        new_build_signature_tail,
        "SessionAgentTask build routing argument",
    )

    old_task_init_tail = """            catalog_preload,
            command_seq: AtomicI64::new(0),
            prompt_dump,
        })
"""
    new_task_init_tail = """            catalog_preload,
            command_seq: AtomicI64::new(0),
            prompt_dump,
            managed_team_routing,
        })
"""
    stext = replace_once(
        stext,
        old_task_init_tail,
        new_task_init_tail,
        "SessionAgentTask routing field initialization",
    )

    old_production_context_anchor = """        // claude/codex gate through CLI flags, not an installed hook file.
        permission_hook_body: _,
    } = inputs;

    // GAP #1/#2 — the pure spec + mode/model mapping (resume anchor → Resume/Fresh,
"""
    new_production_context_anchor = """        // claude/codex gate through CLI flags, not an installed hook file.
        permission_hook_body: _,
    } = inputs;

    let managed_team_routing =
        crate::managed_team_routing::build_managed_team_routing_context_from_env(
            skill_delivery.injected_prefix.as_deref(),
            &config.skills,
            &skill_delivery.skill_dirs,
        )
        .map_err(|error| {
            AgentError::internal(format!(
                "managed Team routing bootstrap failed closed: {error}"
            ))
        })?;

    // GAP #1/#2 — the pure spec + mode/model mapping (resume anchor → Resume/Fresh,
"""
    stext = replace_once(
        stext,
        old_production_context_anchor,
        new_production_context_anchor,
        "production managed Team routing context",
    )

    old_production_ctor = """    let task = SessionAgentTask::new_with_preload(
        AgentType::Acp,
        conversation_id,
        user_id,
        workspace,
        backend,
        acp_session_repo,
        &metadata.handshake,
        prompt_dump,
        // Lets the pump push a usage frame that arrives after the turn's relay has
        // already stopped listening — the claude case (usage rides `result`).
        Some(broadcaster),
    );
"""
    new_production_ctor = """    let task = SessionAgentTask::new_with_preload_and_managed_routing(
        AgentType::Acp,
        conversation_id,
        user_id,
        workspace,
        backend,
        acp_session_repo,
        &metadata.handshake,
        prompt_dump,
        // Lets the pump push a usage frame that arrives after the turn's relay has
        // already stopped listening — the claude case (usage rides `result`).
        Some(broadcaster),
        managed_team_routing,
    );
"""
    stext = replace_once(
        stext,
        old_production_ctor,
        new_production_ctor,
        "production SessionAgentTask managed routing constructor",
    )

    old_send_start = """    async fn send_message(&self, data: SendMessageData) -> Result<(), AgentSendError> {
        self.runtime.touch();
        let content = self.build_prompt_blocks(&data).await;
        // DEV (`--dump-prompts`): borrow the final blocks BEFORE they move into
"""
    new_send_start = """    async fn send_message(&self, data: SendMessageData) -> Result<(), AgentSendError> {
        self.runtime.touch();

        // Managed Team routing runs before any model turn begins. The original
        // user payload is left byte-for-byte untouched; the selected managed
        // skill bodies become a leading text block in Command::Send.
        let routed = match (self.managed_team_routing.as_ref(), data.routing_content.as_deref()) {
            (Some(routing), Some(routing_content)) => Some(
                routing
                    .route_and_render(routing_content)
                    .await
                    .map_err(|error| {
                        AgentSendError::from_agent_error(AgentError::internal(
                            format!("managed Team routing failed closed: {error}")
                        ))
                    })?,
            ),
            // Team native slash commands intentionally carry no routing_content:
            // keep command dispatch byte-identical and inject no managed task skills.
            (Some(_), None) => None,
            (None, _) => None,
        };

        let mut content = self.build_prompt_blocks(&data).await;

        if let Some(routed) = routed {
            tracing::info!(
                conversation_id = %self.conversation_id,
                task_class = %routed.route.task_class,
                route = %routed.route.route,
                primary = %routed.route.primary,
                supports = ?routed.route.support,
                gates = ?routed.route.gates,
                loaded_skills = ?routed.loaded_skills,
                "managed skill routing"
            );

            content.insert(0, ContentBlock::Text(routed.preamble));
        }

        // DEV (`--dump-prompts`): borrow the final blocks BEFORE they move into
"""
    stext = replace_once(
        stext,
        old_send_start,
        new_send_start,
        "managed routing before direct Session Command::Send",
    )


    # FIX-2B compatibility: upstream tests calling SessionAgentTask::build
    # directly need the new optional managed_team_routing argument. Production
    # behaviour is unchanged: these ordinary session tests explicitly pass None.
    direct_build_tests = (
        "send_message_dumps_final_input_when_enabled",
        "send_message_dumps_image_block_raw_base64",
        "send_message_no_dump_when_disabled",
    )

    for test_name in direct_build_tests:
        test_marker = f"async fn {test_name}()"
        test_start = stext.find(test_marker)

        if test_start < 0:
            fail(f"FIX-2B compatibility test marker missing: {test_name}")

        call_start = stext.find(
            "let task = SessionAgentTask::build(",
            test_start,
        )

        if call_start < 0:
            fail(f"FIX-2B direct build call missing in test: {test_name}")

        call_end = stext.find(
            "        );",
            call_start,
        )

        if call_end < 0:
            fail(f"FIX-2B direct build call end missing in test: {test_name}")

        # Existing final argument is `broadcaster`; append the new optional
        # managed_team_routing argument immediately before the call closes.
        stext = (
            stext[:call_end]
            + "            None,\n"
            + stext[call_end:]
        )

    session_agent_file.write_text(stext, encoding="utf-8")

    # Deterministic task -> router.yaml selection engine. This is deliberately
    # isolated from SessionAgentTask wiring so its policy semantics can be
    # compiled and tested independently first.
    routing_source = 'use std::collections::{HashMap, HashSet};\nuse std::path::{Path, PathBuf};\n\nuse aionui_session::SkillDirSpec;\nuse serde::Deserialize;\n\nconst ROUTER_BOOTSTRAP_MARKER: &str = "## Bootstrapped Skill: skill-design";\n\n#[derive(Debug, Deserialize)]\nstruct ManagedRouter {\n    limits: ManagedRouterLimits,\n    modes: HashMap<String, HashMap<String, ManagedRouteSpec>>,\n    #[serde(default)]\n    gates: HashMap<String, String>,\n}\n\n#[derive(Debug, Deserialize)]\nstruct ManagedRouterLimits {\n    primary: usize,\n    support: usize,\n}\n\n#[derive(Debug, Deserialize)]\nstruct ManagedRouteSpec {\n    primary: String,\n    #[serde(default)]\n    support: Vec<String>,\n}\n\n#[derive(Debug, Clone, PartialEq, Eq)]\npub(crate) struct ManagedTaskRoute {\n    pub task_class: String,\n    pub route: String,\n    pub primary: String,\n    pub support: Vec<String>,\n    pub gates: Vec<String>,\n}\n\n#[derive(Debug, Clone, PartialEq, Eq)]\npub(crate) struct ManagedRoutedPrompt {\n    pub route: ManagedTaskRoute,\n    pub preamble: String,\n    pub loaded_skills: Vec<String>,\n}\n\n#[derive(Debug, Clone)]\npub(crate) struct ManagedTeamRoutingContext {\n    router_yaml: String,\n    allowed_skill_names: Vec<String>,\n    skill_sources: HashMap<String, PathBuf>,\n    managed_root: PathBuf,\n}\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq)]\nstruct ClassifiedRoute {\n    task_class: &\'static str,\n    mode: &\'static str,\n    key: &\'static str,\n}\n\nfn contains_any(text: &str, needles: &[&str]) -> bool {\n    needles.iter().any(|needle| text.contains(needle))\n}\n\nfn normalize_task_text(content: &str) -> String {\n    content\n        .to_lowercase()\n        .replace(\'á\', "a")\n        .replace(\'é\', "e")\n        .replace(\'í\', "i")\n        .replace(\'ó\', "o")\n        .replace(\'ú\', "u")\n        .replace(\'ü\', "u")\n}\n\nfn classify_managed_task(content: &str) -> Result<ClassifiedRoute, String> {\n    let text = normalize_task_text(content);\n\n    if contains_any(\n        &text,\n        &[\n            "auditoria ux",\n            "diagnostico ux",\n            "ux audit",\n            "usability audit",\n            "auditoria de usabilidad",\n            "heuristica ux",\n            "heuristicas ux",\n            "problemas de usabilidad",\n        ],\n    ) {\n        return Ok(ClassifiedRoute {\n            task_class: "ux_audit",\n            mode: "design",\n            key: "ux_audit",\n        });\n    }\n\n    if contains_any(\n        &text,\n        &[\n            "design system",\n            "sistema de diseño",\n            "sistema de diseno",\n            "design tokens",\n            "tokens de diseño",\n            "tokens de diseno",\n        ],\n    ) {\n        return Ok(ClassifiedRoute {\n            task_class: "design_system",\n            mode: "design",\n            key: "design_system",\n        });\n    }\n\n    if contains_any(\n        &text,\n        &[\n            "tipografia",\n            "typography",\n            "font pairing",\n            "jerarquia tipografica",\n        ],\n    ) {\n        return Ok(ClassifiedRoute {\n            task_class: "typography",\n            mode: "design",\n            key: "typography",\n        });\n    }\n\n    if contains_any(\n        &text,\n        &[\n            "theme",\n            "tema visual",\n            "dark mode",\n            "light mode",\n            "paleta de colores",\n        ],\n    ) {\n        return Ok(ClassifiedRoute {\n            task_class: "theme",\n            mode: "design",\n            key: "theme",\n        });\n    }\n\n    if contains_any(\n        &text,\n        &[\n            "three.js",\n            "threejs",\n            "escena 3d",\n            "3d interactivo",\n            "interactive 3d",\n        ],\n    ) {\n        return Ok(ClassifiedRoute {\n            task_class: "interactive_3d",\n            mode: "build",\n            key: "interactive_3d",\n        });\n    }\n\n    if contains_any(\n        &text,\n        &[\n            "motion",\n            "animacion",\n            "microinteraccion",\n            "microinteraction",\n            "timeline",\n        ],\n    ) {\n        return Ok(ClassifiedRoute {\n            task_class: "motion",\n            mode: "design",\n            key: "motion",\n        });\n    }\n\n    if contains_any(\n        &text,\n        &[\n            "html interactivo",\n            "interactive html",\n            "artefacto web",\n            "web artifact",\n        ],\n    ) {\n        return Ok(ClassifiedRoute {\n            task_class: "interactive_html",\n            mode: "build",\n            key: "interactive_html",\n        });\n    }\n\n    if contains_any(\n        &text,\n        &[\n            "nueva interfaz",\n            "nueva pagina",\n            "new ui",\n            "new interface",\n            "new page",\n            "crear interfaz",\n            "crear una interfaz",\n        ],\n    ) {\n        return Ok(ClassifiedRoute {\n            task_class: "new_ui",\n            mode: "design",\n            key: "new_ui",\n        });\n    }\n\n    if contains_any(\n        &text,\n        &[\n            "rediseño",\n            "rediseno",\n            "redesign",\n            "refactor ui",\n            "refactorizar interfaz",\n            "interfaz existente",\n            "existing ui",\n        ],\n    ) {\n        return Ok(ClassifiedRoute {\n            task_class: "redesign",\n            mode: "design",\n            key: "redesign",\n        });\n    }\n\n    if contains_any(\n        &text,\n        &[\n            "vulnerabilidad",\n            "security review",\n            "revision de seguridad",\n            "auditoria de seguridad",\n            "autenticacion",\n            "authorization",\n            "autorizacion",\n        ],\n    ) {\n        return Ok(ClassifiedRoute {\n            task_class: "security",\n            mode: "security",\n            key: "default",\n        });\n    }\n\n    if contains_any(\n        &text,\n        &[\n            "debug",\n            "depurar",\n            "bug",\n            "failing test",\n            "test fallando",\n            "error de build",\n            "build failure",\n        ],\n    ) {\n        return Ok(ClassifiedRoute {\n            task_class: "debug",\n            mode: "debug",\n            key: "default",\n        });\n    }\n\n    if contains_any(\n        &text,\n        &[\n            "code review",\n            "revision de codigo",\n            "revisa la implementacion",\n            "review implementation",\n        ],\n    ) {\n        return Ok(ClassifiedRoute {\n            task_class: "implementation_review",\n            mode: "review",\n            key: "implementation",\n        });\n    }\n\n    Err("managed Team router could not classify task".to_owned())\n}\n\nfn task_is_read_only(content: &str) -> bool {\n    let text = normalize_task_text(content);\n    contains_any(\n        &text,\n        &[\n            "no modifiques",\n            "no modificar",\n            "solo lectura",\n            "solo analisis",\n            "read-only",\n            "read only",\n            "do not modify",\n            "do not edit",\n        ],\n    )\n}\n\nfn required_gate_conditions(content: &str) -> Vec<&\'static str> {\n    let text = normalize_task_text(content);\n    let mut result = Vec::new();\n\n    if contains_any(\n        &text,\n        &[\n            "http://",\n            "https://",\n            "contenido externo",\n            "third-party content",\n            "third party content",\n            "contenido de terceros",\n        ],\n    ) {\n        result.push("untrusted_content");\n    }\n\n    if contains_any(\n        &text,\n        &[\n            "autenticacion",\n            "authorization",\n            "autorizacion",\n            "permiso",\n            "permission",\n            "secret",\n            "secreto",\n            "token",\n            "password",\n            "contraseña",\n            "contrasena",\n            "payment",\n            "pago",\n            "upload",\n            "subida de archivos",\n        ],\n    ) {\n        result.push("sensitive_surface");\n    }\n\n    if !task_is_read_only(content)\n        && contains_any(\n            &text,\n            &[\n                "implementa",\n                "implementar",\n                "modifica",\n                "modificar",\n                "corrige",\n                "corregir",\n                "fix ",\n                "refactoriza",\n                "refactorizar",\n                "crea ",\n                "crear ",\n            ],\n        )\n    {\n        result.push("behavior_change");\n    }\n\n    if contains_any(\n        &text,\n        &[\n            "demo publica",\n            "public demo",\n            "placeholder brand",\n            "marca ficticia",\n            "identidad ficticia",\n        ],\n    ) {\n        result.push("public_demo_or_placeholder_brand");\n    }\n\n    result\n}\n\npub(crate) fn route_managed_team_task(\n    router_yaml: &str,\n    content: &str,\n    allowed_skill_names: &[String],\n) -> Result<ManagedTaskRoute, String> {\n    let router: ManagedRouter = serde_yaml::from_str(router_yaml)\n        .map_err(|error| format!("managed Team router YAML is invalid: {error}"))?;\n\n    if router.limits.primary != 1 {\n        return Err(format!(\n            "managed Team router requires limits.primary=1, got {}",\n            router.limits.primary\n        ));\n    }\n\n    let classified = classify_managed_task(content)?;\n\n    let route_spec = router\n        .modes\n        .get(classified.mode)\n        .and_then(|mode| mode.get(classified.key))\n        .ok_or_else(|| {\n            format!(\n                "managed Team router missing route {}.{}",\n                classified.mode, classified.key\n            )\n        })?;\n\n    let allowed: HashSet<&str> =\n        allowed_skill_names.iter().map(String::as_str).collect();\n\n    if !allowed.contains(route_spec.primary.as_str()) {\n        return Err(format!(\n            "managed Team router primary \'{}\' is outside role allowlist",\n            route_spec.primary\n        ));\n    }\n\n    let support_cap = router.limits.support.min(2);\n\n    let support: Vec<String> = route_spec\n        .support\n        .iter()\n        .filter(|name| allowed.contains(name.as_str()))\n        .take(support_cap)\n        .cloned()\n        .collect();\n\n    let mut gates = Vec::new();\n\n    for condition in required_gate_conditions(content) {\n        let skill = router.gates.get(condition).ok_or_else(|| {\n            format!(\n                "managed Team router missing mandatory gate mapping for \'{condition}\'"\n            )\n        })?;\n\n        if !allowed.contains(skill.as_str()) {\n            return Err(format!(\n                "managed Team router mandatory gate \'{}\' is outside role allowlist",\n                skill\n            ));\n        }\n\n        if skill != &route_spec.primary\n            && !support.iter().any(|name| name == skill)\n            && !gates.iter().any(|name| name == skill)\n        {\n            gates.push(skill.clone());\n        }\n    }\n\n    Ok(ManagedTaskRoute {\n        task_class: classified.task_class.to_owned(),\n        route: format!("{}.{}", classified.mode, classified.key),\n        primary: route_spec.primary.clone(),\n        support,\n        gates,\n    })\n}\n\nfn router_bootstrap_active(injected_prefix: Option<&str>) -> bool {\n    injected_prefix.is_some_and(|prefix| prefix.contains(ROUTER_BOOTSTRAP_MARKER))\n}\n\npub(crate) fn build_managed_team_routing_context(\n    injected_prefix: Option<&str>,\n    allowed_skill_names: &[String],\n    skill_dirs: &[SkillDirSpec],\n    router_path: &Path,\n) -> Result<Option<ManagedTeamRoutingContext>, String> {\n    if !router_bootstrap_active(injected_prefix) {\n        return Ok(None);\n    }\n\n    if !allowed_skill_names.iter().any(|name| name == "skill-design") {\n        return Err(\n            "managed Team router bootstrap marker exists but skill-design is absent from allowlist"\n                .to_owned(),\n        );\n    }\n\n    let mut skill_sources = HashMap::new();\n\n    for skill in skill_dirs {\n        let source = PathBuf::from(&skill.path);\n\n        if skill_sources.insert(skill.name.clone(), source).is_some() {\n            return Err(format!(\n                "managed Team routing found duplicate resolved source for \'{}\'",\n                skill.name\n            ));\n        }\n    }\n\n    let router_source = skill_sources.get("skill-design").ok_or_else(|| {\n        "managed Team routing requires resolved skill-design source".to_owned()\n    })?;\n\n    let managed_root = router_source\n        .parent()\n        .ok_or_else(|| {\n            "managed Team routing could not derive managed skill bundle root".to_owned()\n        })?\n        .to_path_buf();\n\n    if router_source.file_name().and_then(|name| name.to_str()) != Some("skill-design") {\n        return Err(\n            "managed Team routing skill-design source has unexpected directory name"\n                .to_owned(),\n        );\n    }\n\n    let router_yaml = std::fs::read_to_string(router_path).map_err(|error| {\n        format!(\n            "managed Team routing could not read router \'{}\': {error}",\n            router_path.display()\n        )\n    })?;\n\n    if router_yaml.trim().is_empty() {\n        return Err("managed Team routing router.yaml is empty".to_owned());\n    }\n\n    serde_yaml::from_str::<ManagedRouter>(&router_yaml)\n        .map_err(|error| format!("managed Team router YAML is invalid: {error}"))?;\n\n    Ok(Some(ManagedTeamRoutingContext {\n        router_yaml,\n        allowed_skill_names: allowed_skill_names.to_vec(),\n        skill_sources,\n        managed_root,\n    }))\n}\n\npub(crate) fn build_managed_team_routing_context_from_env(\n    injected_prefix: Option<&str>,\n    allowed_skill_names: &[String],\n    skill_dirs: &[SkillDirSpec],\n) -> Result<Option<ManagedTeamRoutingContext>, String> {\n    if !router_bootstrap_active(injected_prefix) {\n        return Ok(None);\n    }\n\n    let router_path = std::env::var("AIONUI_MANAGED_SKILL_ROUTER")\n        .map_err(|_| {\n            "managed Team routing is active but AIONUI_MANAGED_SKILL_ROUTER is missing"\n                .to_owned()\n        })?;\n\n    build_managed_team_routing_context(\n        injected_prefix,\n        allowed_skill_names,\n        skill_dirs,\n        Path::new(&router_path),\n    )\n}\n\nimpl ManagedTeamRoutingContext {\n    pub(crate) async fn route_and_render(\n        &self,\n        content: &str,\n    ) -> Result<ManagedRoutedPrompt, String> {\n        let route = route_managed_team_task(\n            &self.router_yaml,\n            content,\n            &self.allowed_skill_names,\n        )?;\n\n        let mut selected = Vec::new();\n        selected.push(route.primary.clone());\n        selected.extend(route.support.iter().cloned());\n        selected.extend(route.gates.iter().cloned());\n\n        let mut seen = HashSet::new();\n        selected.retain(|name| seen.insert(name.clone()));\n\n        let mut rendered = Vec::new();\n\n        for name in &selected {\n            let source = self.skill_sources.get(name).ok_or_else(|| {\n                format!(\n                    "managed Team routing selected \'{}\' but no resolved skill source exists",\n                    name\n                )\n            })?;\n\n            if source.parent() != Some(self.managed_root.as_path()) {\n                return Err(format!(\n                    "managed Team routing selected \'{}\' outside managed bundle root",\n                    name\n                ));\n            }\n\n            let skill_file = source.join("SKILL.md");\n\n            let raw = tokio::fs::read_to_string(&skill_file)\n                .await\n                .map_err(|error| {\n                    format!(\n                        "managed Team routing could not read \'{}\': {error}",\n                        skill_file.display()\n                    )\n                })?;\n\n            let body = aionui_extension::skill_service::extract_skill_body(&raw);\n\n            if body.trim().is_empty() {\n                return Err(format!(\n                    "managed Team routing selected \'{}\' with empty skill body",\n                    name\n                ));\n            }\n\n            rendered.push((\n                name.clone(),\n                source.clone(),\n                body,\n            ));\n        }\n\n        let supports = if route.support.is_empty() {\n            "-".to_owned()\n        } else {\n            route.support.join(",")\n        };\n\n        let gates = if route.gates.is_empty() {\n            "-".to_owned()\n        } else {\n            route.gates.join(",")\n        };\n\n        let mut preamble = format!(\n            "[Managed Team Skill Routing]\\n\\\n             task_class={}\\n\\\n             route={}\\n\\\n             primary={}\\n\\\n             supports={}\\n\\\n             gates={}\\n",\n            route.task_class,\n            route.route,\n            route.primary,\n            supports,\n            gates,\n        );\n\n        for (name, source, body) in &rendered {\n            preamble.push_str("\\n[Skill: ");\n            preamble.push_str(name);\n            preamble.push_str(\n                "]\\nSkill root (resolve every relative path in this body against it): "\n            );\n            preamble.push_str(&source.display().to_string());\n            preamble.push_str("\\n\\n");\n            preamble.push_str(body.trim());\n            preamble.push(\'\\n\');\n        }\n\n        preamble.push_str("[/Managed Team Skill Routing]\\n");\n\n        Ok(ManagedRoutedPrompt {\n            route,\n            preamble,\n            loaded_skills: selected,\n        })\n    }\n}\n\n#[cfg(test)]\nmod managed_team_skill_routing_tests {\n    use super::*;\n\n    const A1_TASK: &str =\n        "Revisa únicamente el archivo TeamCreateModal.tsx y entrega un diagnóstico UX breve, \\\n         priorizando los problemas encontrados y proponiendo mejoras concretas. \\\n         No modifiques archivos. Solo lectura y análisis.";\n\n    const ROUTER: &str = r#"\nversion: 3\nlimits:\n  primary: 1\n  support: 2\n  normal_total: 5\n  hard_total: 7\nmodes:\n  design:\n    ux_audit:\n      primary: ux-heuristics\n      support: [refactoring-ui]\n    new_ui:\n      primary: frontend-design\n      support: [ui-ux-pro-max, web-typography, microinteractions]\n  debug:\n    default:\n      primary: debug-gate\n      support: [test-first-gate]\n  review:\n    implementation:\n      primary: ship-gate\n      support: [security-gate]\n  security:\n    default:\n      primary: security-gate\n      support: [prompt-injection-gate, ship-gate]\n  build:\n    interactive_3d:\n      primary: web-motion-toolkit\n      support: [web-artifact-builder, frontend-design]\n    interactive_html:\n      primary: web-artifact-builder\n      support: [frontend-design, test-first-gate]\ngates:\n  untrusted_content: prompt-injection-gate\n  public_demo_or_placeholder_brand: business-identity-gate\n  sensitive_surface: security-gate\n  behavior_change: test-first-gate\n  completion_claim: ship-gate\n"#;\n\n    fn frontend_allowlist() -> Vec<String> {\n        [\n            "skill-design",\n            "frontend-design",\n            "refactoring-ui",\n            "ui-ux-pro-max",\n            "ux-heuristics",\n            "web-typography",\n            "microinteractions",\n            "theme-factory",\n            "web-motion-toolkit",\n            "web-artifact-builder",\n            "generative-art",\n            "business-identity-gate",\n            "prompt-injection-gate",\n            "test-first-gate",\n            "security-gate",\n            "ship-gate",\n        ]\n        .into_iter()\n        .map(str::to_owned)\n        .collect()\n    }\n\n    fn write_skill(root: &Path, name: &str, marker: &str) -> SkillDirSpec {\n        let dir = root.join(name);\n        std::fs::create_dir_all(&dir).unwrap();\n        std::fs::write(\n            dir.join("SKILL.md"),\n            format!(\n                "---\\nname: {name}\\ndescription: test\\n---\\n{marker}\\n"\n            ),\n        )\n        .unwrap();\n\n        SkillDirSpec {\n            name: name.to_owned(),\n            path: dir.to_string_lossy().into_owned(),\n        }\n    }\n\n    fn write_router(tmp: &Path) -> PathBuf {\n        let path = tmp.join("router.yaml");\n        std::fs::write(&path, ROUTER).unwrap();\n        path\n    }\n\n    #[test]\n    fn spanish_a1_task_routes_to_ux_audit() {\n        let route =\n            route_managed_team_task(ROUTER, A1_TASK, &frontend_allowlist())\n                .unwrap();\n\n        assert_eq!(route.task_class, "ux_audit");\n        assert_eq!(route.route, "design.ux_audit");\n        assert_eq!(route.primary, "ux-heuristics");\n        assert_eq!(route.support, vec!["refactoring-ui"]);\n        assert!(route.gates.is_empty());\n    }\n\n    #[test]\n    fn primary_and_support_are_read_from_yaml_not_hardcoded_pair() {\n        let yaml = ROUTER\n            .replace("ux-heuristics", "yaml-primary")\n            .replace("refactoring-ui", "yaml-support");\n\n        let allowed = vec![\n            "skill-design".to_owned(),\n            "yaml-primary".to_owned(),\n            "yaml-support".to_owned(),\n        ];\n\n        let route =\n            route_managed_team_task(&yaml, A1_TASK, &allowed).unwrap();\n\n        assert_eq!(route.primary, "yaml-primary");\n        assert_eq!(route.support, vec!["yaml-support"]);\n    }\n\n    #[test]\n    fn support_never_exceeds_router_or_runtime_cap() {\n        let task = "Crear una nueva interfaz para el panel principal";\n\n        let route =\n            route_managed_team_task(ROUTER, task, &frontend_allowlist())\n                .unwrap();\n\n        assert_eq!(route.primary, "frontend-design");\n        assert_eq!(\n            route.support,\n            vec![\n                "ui-ux-pro-max".to_owned(),\n                "web-typography".to_owned()\n            ]\n        );\n        assert!(route.support.len() <= 2);\n    }\n\n    #[test]\n    fn primary_outside_allowlist_fails_closed() {\n        let allowed = vec![\n            "skill-design".to_owned(),\n            "refactoring-ui".to_owned(),\n        ];\n\n        let error =\n            route_managed_team_task(ROUTER, A1_TASK, &allowed).unwrap_err();\n\n        assert!(error.contains("outside role allowlist"));\n        assert!(error.contains("ux-heuristics"));\n    }\n\n    #[test]\n    fn mandatory_gate_outside_allowlist_fails_closed() {\n        let allowed = vec![\n            "skill-design".to_owned(),\n            "frontend-design".to_owned(),\n            "ui-ux-pro-max".to_owned(),\n            "web-typography".to_owned(),\n        ];\n\n        let error = route_managed_team_task(\n            ROUTER,\n            "Crear una nueva interfaz que modifica el comportamiento",\n            &allowed,\n        )\n        .unwrap_err();\n\n        assert!(error.contains("mandatory gate"));\n        assert!(error.contains("test-first-gate"));\n    }\n\n    #[test]\n    fn a1_read_only_language_does_not_add_behavior_change_gate() {\n        let route =\n            route_managed_team_task(ROUTER, A1_TASK, &frontend_allowlist())\n                .unwrap();\n\n        assert!(!route.gates.iter().any(|name| name == "test-first-gate"));\n    }\n\n    #[test]\n    fn conversation_without_bootstrap_marker_has_no_managed_routing_context() {\n        let tmp = tempfile::TempDir::new().unwrap();\n\n        let result = build_managed_team_routing_context(\n            Some("[Assistant Rules]\\nordinary\\n[/Assistant Rules]"),\n            &frontend_allowlist(),\n            &[],\n            &tmp.path().join("missing-router.yaml"),\n        )\n        .unwrap();\n\n        assert!(result.is_none());\n    }\n\n    #[tokio::test]\n    async fn selected_skill_without_resolved_source_fails_closed() {\n        let tmp = tempfile::TempDir::new().unwrap();\n        let root = tmp.path().join("skills");\n        std::fs::create_dir_all(&root).unwrap();\n\n        let dirs = vec![\n            write_skill(&root, "skill-design", "ROUTER_BOOTSTRAP_BODY"),\n        ];\n\n        let router_path = write_router(tmp.path());\n\n        let ctx = build_managed_team_routing_context(\n            Some(\n                "[Assistant Rules]\\n\\\n                 ## Bootstrapped Skill: skill-design\\n\\\n                 [/Assistant Rules]"\n            ),\n            &frontend_allowlist(),\n            &dirs,\n            &router_path,\n        )\n        .unwrap()\n        .unwrap();\n\n        let error = ctx.route_and_render(A1_TASK).await.unwrap_err();\n\n        assert!(error.contains("ux-heuristics"));\n        assert!(error.contains("no resolved skill source"));\n    }\n\n    #[tokio::test]\n    async fn selected_skill_bodies_are_rendered_into_managed_preamble() {\n        let tmp = tempfile::TempDir::new().unwrap();\n        let root = tmp.path().join("skills");\n        std::fs::create_dir_all(&root).unwrap();\n\n        let dirs = vec![\n            write_skill(&root, "skill-design", "ROUTER_BOOTSTRAP_BODY"),\n            write_skill(&root, "ux-heuristics", "UX_BODY_MARKER"),\n            write_skill(&root, "refactoring-ui", "REFACTOR_BODY_MARKER"),\n        ];\n\n        let router_path = write_router(tmp.path());\n\n        let ctx = build_managed_team_routing_context(\n            Some(\n                "[Assistant Rules]\\n\\\n                 ## Bootstrapped Skill: skill-design\\n\\\n                 [/Assistant Rules]"\n            ),\n            &frontend_allowlist(),\n            &dirs,\n            &router_path,\n        )\n        .unwrap()\n        .unwrap();\n\n        let routed = ctx.route_and_render(A1_TASK).await.unwrap();\n\n        assert_eq!(\n            routed.loaded_skills,\n            vec![\n                "ux-heuristics".to_owned(),\n                "refactoring-ui".to_owned()\n            ]\n        );\n\n        assert!(routed.preamble.contains("task_class=ux_audit"));\n        assert!(routed.preamble.contains("route=design.ux_audit"));\n        assert!(routed.preamble.contains("primary=ux-heuristics"));\n        assert!(routed.preamble.contains("supports=refactoring-ui"));\n        assert!(routed.preamble.contains("[Skill: ux-heuristics]"));\n        assert!(routed.preamble.contains("UX_BODY_MARKER"));\n        assert!(routed.preamble.contains("[Skill: refactoring-ui]"));\n        assert!(routed.preamble.contains("REFACTOR_BODY_MARKER"));\n        assert!(routed.preamble.ends_with("[/Managed Team Skill Routing]\\n"));\n    }\n}\n'
    routing_file = root / "crates/aionui-ai-agent/src/managed_team_routing.rs"
    if routing_file.exists():
        fail("managed Team routing module already exists")
    routing_file.write_text(routing_source, encoding="utf-8")

    # FIX-2C: carry semantic Team task content as structured turn metadata.
    # Routing must never parse the human-readable Team Governance/wake prompt:
    # that format is intentionally readable and therefore ambiguous when user
    # content contains strings that look like mailbox headers. The Team layer
    # already owns structured mailbox/task data, so extract intent there and
    # carry it through AgentTurnRequest -> ConversationAgentTurnRequest ->
    # TurnStartInput -> SendMessageData. Ordinary callers use None.

    rtext = routing_file.read_text(encoding="utf-8")
    sensitive_test_anchor = r'''    #[test]
    fn primary_and_support_are_read_from_yaml_not_hardcoded_pair() {
'''
    sensitive_test = r'''    #[test]
    fn sensitive_a1_task_adds_security_gate() {
        let task = format!("{A1_TASK} Revisa también el campo password.");
        let route = route_managed_team_task(
            ROUTER,
            &task,
            &frontend_allowlist(),
        )
        .unwrap();

        assert_eq!(route.task_class, "ux_audit");
        assert_eq!(route.gates, vec!["security-gate".to_owned()]);
    }

'''
    rtext = replace_once(
        rtext,
        sensitive_test_anchor,
        sensitive_test + sensitive_test_anchor,
        "managed Team real-sensitive-task routing regression test",
    )
    routing_file.write_text(rtext, encoding="utf-8")

    # SendMessageData: optional semantic routing input. It is internal metadata,
    # not model-visible content, and defaults to None for every ordinary caller.
    types_file = root / "crates/aionui-ai-agent/src/types.rs"
    ttext = types_file.read_text(encoding="utf-8")
    ttext = replace_once(
        ttext,
        "    /// User message content.\n"
        "    pub content: String,\n"
        "    /// Client-generated message ID for correlation.\n",
        "    /// User message content.\n"
        "    pub content: String,\n"
        "    /// Semantic task content used only by managed Team routing.\n"
        "    #[serde(default, skip_serializing_if = \"Option::is_none\")]\n"
        "    pub routing_content: Option<String>,\n"
        "    /// Client-generated message ID for correlation.\n",
        "SendMessageData semantic routing field",
    )
    ttext = replace_once(
        ttext,
        "            content: \"Hello\".into(),\n"
        "            msg_id: \"msg-001\".into(),\n",
        "            content: \"Hello\".into(),\n"
        "            routing_content: Some(\"semantic task\".into()),\n"
        "            msg_id: \"msg-001\".into(),\n",
        "SendMessageData serde test routing field",
    )
    ttext = replace_once(
        ttext,
        "        assert_eq!(json[\"content\"], \"Hello\");\n",
        "        assert_eq!(json[\"content\"], \"Hello\");\n"
        "        assert_eq!(json[\"routing_content\"], \"semantic task\");\n",
        "SendMessageData serde test routing assertion",
    )
    ttext = replace_once(
        ttext,
        "        assert_eq!(parsed.content, \"Hello\");\n"
        "        assert_eq!(parsed.msg_id, \"msg-001\");\n",
        "        assert_eq!(parsed.content, \"Hello\");\n"
        "        assert_eq!(parsed.routing_content.as_deref(), Some(\"semantic task\"));\n"
        "        assert_eq!(parsed.msg_id, \"msg-001\");\n",
        "SendMessageData serde parsed routing assertion",
    )
    ttext = replace_once(
        ttext,
        "        assert!(data.turn_id.is_none());\n"
        "        assert!(data.files.is_empty());\n",
        "        assert!(data.turn_id.is_none());\n"
        "        assert!(data.routing_content.is_none());\n"
        "        assert!(data.files.is_empty());\n",
        "SendMessageData serde default routing assertion",
    )
    types_file.write_text(ttext, encoding="utf-8")

    # Team owns the structured source of truth. Pick the latest normal mailbox
    # message; if a task wake has no message, use the newest active owned task.
    team_session_file = root / "crates/aionui-team/src/session.rs"
    team_session = team_session_file.read_text(encoding="utf-8")
    team_session = replace_once(
        team_session,
        "use crate::types::{MailboxMessage, MailboxMessageType, Team, TeamAgent, TeammateRole, TeammateStatus};",
        "use crate::types::{MailboxMessage, MailboxMessageType, TaskStatus, Team, TeamAgent, TeammateRole, TeammateStatus};",
        "Team session TaskStatus import for routing content",
    )
    team_session = replace_once(
        team_session,
        "    pub first_message: String,\n"
        "    /// Unread mailbox rows used to build `first_message`. Returned so the\n",
        "    pub first_message: String,\n"
        "    /// Structured semantic task content for managed skill routing.\n"
        "    /// None is reserved for native slash commands, which bypass task routing.\n"
        "    pub routing_content: Option<String>,\n"
        "    /// Unread mailbox rows used to build `first_message`. Returned so the\n",
        "WakeInput semantic routing field",
    )
    routing_content_anchor = r'''                let (first_message, needs_role_prompt) = if batch.is_command {
'''
    routing_content_block = r'''                let routing_content = if batch.is_command {
                    // Native slash commands intentionally bypass managed task
                    // routing. Their content must stay byte-identical for the
                    // backend command dispatcher.
                    None
                } else {
                    Some(
                        claimed_unread
                            .iter()
                            .rev()
                            .find(|message| {
                                message.msg_type == MailboxMessageType::Message
                                    && !message.content.trim().is_empty()
                            })
                            .map(|message| message.content.clone())
                            .or_else(|| {
                                tasks
                                    .iter()
                                    .filter(|task| task.owner.as_deref() == Some(slot_id))
                                    .filter(|task| {
                                        matches!(task.status, TaskStatus::Pending | TaskStatus::InProgress)
                                    })
                                    .max_by_key(|task| task.updated_at)
                                    .map(|task| {
                                        let description = task
                                            .description
                                            .as_deref()
                                            .map(str::trim)
                                            .filter(|description| !description.is_empty());
                                        match description {
                                            Some(description) => format!("{}\n{}", task.subject, description),
                                            None => task.subject.clone(),
                                        }
                                    })
                            })
                            // Some("") is deliberate for a non-command Team
                            // turn with no routable task: managed routing then
                            // fails closed instead of inspecting Governance.
                            .unwrap_or_default(),
                    )
                };

'''
    team_session = replace_once(
        team_session,
        routing_content_anchor,
        routing_content_block + routing_content_anchor,
        "Team structured semantic routing content",
    )
    team_session = replace_once(
        team_session,
        "                        conversation_id: agent.conversation_id,\n"
        "                        first_message,\n"
        "                        unread: claimed_unread,\n",
        "                        conversation_id: agent.conversation_id,\n"
        "                        first_message,\n"
        "                        routing_content,\n"
        "                        unread: claimed_unread,\n",
        "WakeInput semantic routing construction",
    )
    team_session_file.write_text(team_session, encoding="utf-8")

    ports_file = root / "crates/aionui-team/src/ports.rs"
    ports = ports_file.read_text(encoding="utf-8")
    ports = replace_once(
        ports,
        "    pub content: String,\n"
        "    pub files: Vec<String>,\n"
        "    pub source: AgentTurnSource,\n",
        "    pub content: String,\n"
        "    pub routing_content: Option<String>,\n"
        "    pub files: Vec<String>,\n"
        "    pub source: AgentTurnSource,\n",
        "AgentTurnRequest semantic routing field",
    )
    ports_file.write_text(ports, encoding="utf-8")

    event_loop_file = root / "crates/aionui-team/src/event_loop.rs"
    event_loop = event_loop_file.read_text(encoding="utf-8")
    event_loop = replace_once(
        event_loop,
        "        content: input.first_message,\n"
        "        files,\n",
        "        content: input.first_message,\n"
        "        routing_content: input.routing_content,\n"
        "        files,\n",
        "AgentTurnRequest semantic routing propagation",
    )
    event_loop_file.write_text(event_loop, encoding="utf-8")

    adapter_file = root / "crates/aionui-app/src/router/team_conversation_adapters.rs"
    adapter = adapter_file.read_text(encoding="utf-8")
    adapter = replace_once(
        adapter,
        "                    content: request.content.clone(),\n"
        "                    files: request.files.clone(),\n",
        "                    content: request.content.clone(),\n"
        "                    routing_content: request.routing_content.clone(),\n"
        "                    files: request.files.clone(),\n",
        "Team conversation adapter semantic routing propagation",
    )
    adapter_file.write_text(adapter, encoding="utf-8")

    conversation_service_file = root / "crates/aionui-conversation/src/service.rs"
    conversation_service = conversation_service_file.read_text(encoding="utf-8")
    conversation_service = replace_once(
        conversation_service,
        "    pub content: String,\n"
        "    pub files: Vec<String>,\n"
        "    pub inject_skills: Vec<String>,\n",
        "    pub content: String,\n"
        "    pub routing_content: Option<String>,\n"
        "    pub files: Vec<String>,\n"
        "    pub inject_skills: Vec<String>,\n",
        "ConversationAgentTurnRequest semantic routing field",
    )
    conversation_service = replace_once(
        conversation_service,
        "            content: resolved.content,\n"
        "            files: resolved.files,\n"
        "            inject_skills: req.inject_skills,\n",
        "            content: resolved.content,\n"
        "            routing_content: None,\n"
        "            files: resolved.files,\n"
        "            inject_skills: req.inject_skills,\n",
        "ordinary conversation routing metadata default",
    )
    conversation_service = replace_once(
        conversation_service,
        "                content: request.content,\n"
        "                files: request.files,\n"
        "                inject_skills: request.inject_skills,\n",
        "                content: request.content,\n"
        "                routing_content: request.routing_content,\n"
        "                files: request.files,\n"
        "                inject_skills: request.inject_skills,\n",
        "internal conversation semantic routing propagation",
    )
    conversation_service_file.write_text(conversation_service, encoding="utf-8")

    turn_file = root / "crates/aionui-conversation/src/turn_orchestrator.rs"
    turn = turn_file.read_text(encoding="utf-8")
    turn = replace_once(
        turn,
        "    pub content: String,\n"
        "    /// Attachment absolute paths, already resolved.\n",
        "    pub content: String,\n"
        "    /// Optional semantic task content for managed Team routing.\n"
        "    pub routing_content: Option<String>,\n"
        "    /// Attachment absolute paths, already resolved.\n",
        "TurnStartInput semantic routing field",
    )
    turn = replace_once(
        turn,
        "        let mut pending_send = Some((input.send, input.msg_id));\n",
        "        let continuation_routing_content = input.send.routing_content.clone();\n"
        "        let mut pending_send = Some((input.send, input.msg_id));\n",
        "continuation semantic routing capture",
    )
    turn = replace_once(
        turn,
        "                            content,\n"
        "                            msg_id: next_turn_msg_id.clone(),\n"
        "                            turn_id: Some(input.turn_id.clone()),\n",
        "                            content,\n"
        "                            routing_content: continuation_routing_content.clone(),\n"
        "                            msg_id: next_turn_msg_id.clone(),\n"
        "                            turn_id: Some(input.turn_id.clone()),\n",
        "continuation SendMessageData semantic routing",
    )
    turn = replace_once(
        turn,
        "        let initial_send = SendMessageData {\n"
        "            content: input.content,\n"
        "            msg_id: first_turn_msg_id.clone(),\n",
        "        let initial_send = SendMessageData {\n"
        "            content: input.content,\n"
        "            routing_content: input.routing_content,\n"
        "            msg_id: first_turn_msg_id.clone(),\n",
        "initial SendMessageData semantic routing",
    )
    turn_file.write_text(turn, encoding="utf-8")

    # Ordinary ConversationAgentTurnRequest callers explicitly opt out.
    cron_file = root / "crates/aionui-cron/src/executor.rs"
    cron = cron_file.read_text(encoding="utf-8")
    cron = replace_once(
        cron,
        "            content: prompt,\n"
        "            files: vec![],\n",
        "            content: prompt,\n"
        "            routing_content: None,\n"
        "            files: vec![],\n",
        "cron semantic routing default",
    )
    cron_file.write_text(cron, encoding="utf-8")

    relay_test_file = root / "crates/aionui-conversation/tests/stream_relay_tool_call.rs"
    relay_test = relay_test_file.read_text(encoding="utf-8")
    relay_test = replace_once(
        relay_test,
        "            content: \"run glob\".into(),\n"
        "            files: Vec::new(),\n",
        "            content: \"run glob\".into(),\n"
        "            routing_content: None,\n"
        "            files: Vec::new(),\n",
        "conversation relay test semantic routing default",
    )
    relay_test_file.write_text(relay_test, encoding="utf-8")

    # SendMessageData test literals outside the turn orchestrator use None.
    acp_agent_file = root / "crates/aionui-ai-agent/src/manager/acp/agent.rs"
    acp_agent = acp_agent_file.read_text(encoding="utf-8")
    acp_agent = replace_once(
        acp_agent,
        "            content: \"original team wake\".into(),\n"
        "            msg_id: \"msg-acp-final\".into(),\n",
        "            content: \"original team wake\".into(),\n"
        "            routing_content: None,\n"
        "            msg_id: \"msg-acp-final\".into(),\n",
        "ACP final input test semantic routing default",
    )
    acp_agent_file.write_text(acp_agent, encoding="utf-8")

    acp_flow_file = root / "crates/aionui-ai-agent/src/manager/acp/agent_session_flow.rs"
    acp_flow = acp_flow_file.read_text(encoding="utf-8")
    flow_anchor = "            turn_id: None,\n            files:"
    flow_count = acp_flow.count(flow_anchor)
    if flow_count != 4:
        fail(f"ACP prompt block SendMessageData anchors: expected 4, found {flow_count}")
    acp_flow = acp_flow.replace(
        flow_anchor,
        "            turn_id: None,\n            routing_content: None,\n            files:",
    )
    acp_flow_file.write_text(acp_flow, encoding="utf-8")

    aionrs_test_file = root / "crates/aionui-ai-agent/src/manager/aionrs/agent_test.rs"
    aionrs_test = aionrs_test_file.read_text(encoding="utf-8")
    aionrs_test = replace_once(
        aionrs_test,
        "        turn_id: Some(\"turn-aionrs-final\".to_owned()),\n"
        "        files: Vec::new(),\n",
        "        turn_id: Some(\"turn-aionrs-final\".to_owned()),\n"
        "        routing_content: None,\n"
        "        files: Vec::new(),\n",
        "AionRS input test semantic routing default",
    )
    aionrs_test_file.write_text(aionrs_test, encoding="utf-8")

    # Existing integration tests now also prove that governance stays in model
    # content while semantic routing input remains the exact structured message.
    team_integration_file = root / "crates/aionui-team/tests/session_service_integration.rs"
    team_integration = team_integration_file.read_text(encoding="utf-8")
    team_integration = replace_once(
        team_integration,
        "    assert!(first_message.contains(\"do X\"));\n",
        "    assert!(first_message.contains(\"do X\"));\n"
        "    assert_eq!(worker_request.routing_content.as_deref(), Some(\"do X\"));\n",
        "teammate semantic routing integration assertion",
    )
    team_integration_file.write_text(team_integration, encoding="utf-8")

    team_e2e_file = root / "crates/aionui-team/tests/e2e_team_flow.rs"
    team_e2e = team_e2e_file.read_text(encoding="utf-8")
    team_e2e = replace_once(
        team_e2e,
        "    assert_eq!(request.user_id, \"user-e2e\");\n"
        "    assert!(request.content.contains(\"user input to team\"));\n",
        "    assert_eq!(request.user_id, \"user-e2e\");\n"
        "    assert!(request.content.contains(\"user input to team\"));\n"
        "    assert_eq!(request.routing_content.as_deref(), Some(\"user input to team\"));\n",
        "lead semantic routing integration assertion",
    )
    command_member_anchor = r'''    assert!(!content.contains("## New Messages"), "command turn must NOT be wrapped");

    session.stop();
'''
    command_member_replacement = r'''    assert!(!content.contains("## New Messages"), "command turn must NOT be wrapped");
    {
        let requests = turn_requests.lock().unwrap();
        let request = requests
            .iter()
            .rev()
            .find(|request| request.slot_id == "worker-1")
            .expect("worker command turn request");
        assert!(
            request.routing_content.is_none(),
            "native slash commands must bypass managed task routing"
        );
    }

    session.stop();
'''
    team_e2e = replace_once(
        team_e2e,
        command_member_anchor,
        command_member_replacement,
        "member native slash routing bypass assertion",
    )
    command_lead_anchor = r'''    assert_eq!(content, "/compact");
    assert!(!content.contains("## New Messages"));

    session.stop();
'''
    command_lead_replacement = r'''    assert_eq!(content, "/compact");
    assert!(!content.contains("## New Messages"));
    {
        let requests = turn_requests.lock().unwrap();
        let request = requests
            .iter()
            .rev()
            .find(|request| request.slot_id == "lead-1")
            .expect("lead command turn request");
        assert!(
            request.routing_content.is_none(),
            "native slash commands must bypass managed task routing"
        );
    }

    session.stop();
'''
    team_e2e = replace_once(
        team_e2e,
        command_lead_anchor,
        command_lead_replacement,
        "lead native slash routing bypass assertion",
    )
    team_e2e_file.write_text(team_e2e, encoding="utf-8")


    # FIX-2D: surface the exact per-turn managed routing as a durable Info tip.
    # StreamRelay already forwards and persists Info tips, so the UI can render
    # the same routing metadata live and after reload without a new DB schema.
    stext = session_agent_file.read_text(encoding="utf-8")
    old_visibility_block = r'''        let mut content = self.build_prompt_blocks(&data).await;

        if let Some(routed) = routed {
            tracing::info!(
                conversation_id = %self.conversation_id,
                task_class = %routed.route.task_class,
                route = %routed.route.route,
                primary = %routed.route.primary,
                supports = ?routed.route.support,
                gates = ?routed.route.gates,
                loaded_skills = ?routed.loaded_skills,
                "managed skill routing"
            );

            content.insert(0, ContentBlock::Text(routed.preamble));
        }
'''
    new_visibility_block = r'''        let mut content = self.build_prompt_blocks(&data).await;
        let mut routing_tip: Option<TipsEventData> = None;

        if let Some(routed) = routed {
            tracing::info!(
                conversation_id = %self.conversation_id,
                task_class = %routed.route.task_class,
                route = %routed.route.route,
                primary = %routed.route.primary,
                supports = ?routed.route.support,
                gates = ?routed.route.gates,
                loaded_skills = ?routed.loaded_skills,
                "managed skill routing"
            );

            routing_tip = Some(TipsEventData {
                content: format!(
                    "Loaded skills: {}",
                    routed.loaded_skills.join(", ")
                ),
                tip_type: TipType::Info,
                code: Some("MANAGED_SKILL_ROUTING".to_owned()),
                params: Some(serde_json::json!({
                    "task_class": routed.route.task_class.clone(),
                    "route": routed.route.route.clone(),
                    "primary": routed.route.primary.clone(),
                    "supports": routed.route.support.clone(),
                    "gates": routed.route.gates.clone(),
                    "loaded_skills": routed.loaded_skills.clone(),
                })),
                supersedes_key: Some(format!(
                    "managed-skill-routing:{}",
                    data.msg_id
                )),
            });

            content.insert(0, ContentBlock::Text(routed.preamble));
        }
'''
    stext = replace_once(
        stext,
        old_visibility_block,
        new_visibility_block,
        "managed Team routing visibility tip construction",
    )

    old_start_event = r'''        let _ = self.runtime.tx.send(AgentStreamEvent::Start(StartEventData {
            session_id: self.runtime.session_id(),
        }));
        self.runtime.set_status(ConversationStatus::Running);
'''
    new_start_event = r'''        let _ = self.runtime.tx.send(AgentStreamEvent::Start(StartEventData {
            session_id: self.runtime.session_id(),
        }));
        self.runtime.set_status(ConversationStatus::Running);
        if let Some(routing_tip) = routing_tip {
            let _ = self.runtime.tx.send(AgentStreamEvent::Tips(routing_tip));
        }
'''
    stext = replace_once(
        stext,
        old_start_event,
        new_start_event,
        "managed Team routing visibility tip emission",
    )
    session_agent_file.write_text(stext, encoding="utf-8")

    agent_lib_file = root / "crates/aionui-ai-agent/src/lib.rs"
    ltext = agent_lib_file.read_text(encoding="utf-8")
    ltext = replace_once(
        ltext,
        "pub mod manager;\n",
        "pub mod manager;\npub(crate) mod managed_team_routing;\n",
        "managed Team routing module registration",
    )
    agent_lib_file.write_text(ltext, encoding="utf-8")

    agent_cargo_file = root / "crates/aionui-ai-agent/Cargo.toml"
    ctext = agent_cargo_file.read_text(encoding="utf-8")
    ctext = replace_once(
        ctext,
        "serde_json.workspace = true\n",
        "serde_json.workspace = true\nserde_yaml.workspace = true\n",
        "managed Team routing serde_yaml dependency",
    )
    agent_cargo_file.write_text(ctext, encoding="utf-8")

    agent_lock_file = root / "Cargo.lock"
    lock_text = agent_lock_file.read_text(encoding="utf-8")

    package_marker = '[[package]]\nname = "aionui-ai-agent"\n'
    package_start = lock_text.find(package_marker)
    if package_start < 0:
        fail("aionui-ai-agent package not found in Cargo.lock")

    package_end = lock_text.find("\n[[package]]", package_start + len(package_marker))
    if package_end < 0:
        fail("aionui-ai-agent Cargo.lock package boundary not found")

    package_text = lock_text[package_start:package_end]

    if ' "serde_yaml",' in package_text:
        fail("aionui-ai-agent Cargo.lock already contains serde_yaml")

    package_text = replace_once(
        package_text,
        ' "serde_json",\n',
        ' "serde_json",\n "serde_yaml",\n',
        "aionui-ai-agent Cargo.lock serde_yaml dependency",
    )

    lock_text = (
        lock_text[:package_start]
        + package_text
        + lock_text[package_end:]
    )

    agent_lock_file.write_text(lock_text, encoding="utf-8")

    print("Patched AionCore managed skills, direct-CLI injected delivery, and dynamic Team role modes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
