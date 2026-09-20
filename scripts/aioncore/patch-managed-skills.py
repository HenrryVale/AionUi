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
        "                    session_mode: row.session_mode.clone(),\n",
        "                    session_mode: managed_team_role_session_mode(req.assistant_id.as_deref())?\n"
        "                        .map(str::to_owned)\n"
        "                        .or(row.session_mode.clone()),\n",
        "spawned role session seed",
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

    print("Patched AionCore managed skills, Claude delivery, and dynamic Team role modes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
