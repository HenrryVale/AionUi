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
    session_agent_file.write_text(stext, encoding="utf-8")

    print("Patched AionCore managed skills, direct-CLI injected delivery, and dynamic Team role modes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
