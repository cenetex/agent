#!/bin/bash
# Common shell functions shared between agent and review entrypoints

set -Eeuo pipefail

# --- GitHub CLI Authentication ---
setup_github_auth() {
  local github_token="$1"
  local git_user_name="$2"
  local git_user_email="$3"

  echo "Setting up GitHub CLI authentication..."

  # Clear any existing gh auth state to avoid conflicts
  gh auth logout --hostname github.com >/dev/null 2>&1 || true

  # Use environment-based auth (preferred for headless environments)
  export GH_TOKEN="${github_token}"

  # Validate authentication by testing repository access
  echo "Validating GitHub App installation token..."
  # Note: We'll validate per-repo in the calling script

  # Configure git identity for commits
  git config --global user.name "${git_user_name}"
  git config --global user.email "${git_user_email}"

  echo "GitHub CLI authentication successful"
}

# --- S3 Artifact Management ---
upload_artifact() {
  local local_file="$1"
  local s3_key="$2"
  local content_type="${3:-text/plain}"
  local artifacts_bucket="$4"

  if [ ! -f "${local_file}" ] || [ ! -s "${local_file}" ]; then
    echo "WARN: File ${local_file} does not exist or is empty, skipping S3 upload"
    return 1
  fi

  aws s3 cp "${local_file}" "s3://${artifacts_bucket}/${s3_key}" \
    --content-type "${content_type}" || {
    echo "WARN: Failed to upload ${local_file} to S3"
    return 1
  }
}

upload_artifact_from_string() {
  local content="$1"
  local s3_key="$2"
  local content_type="${3:-application/json}"
  local artifacts_bucket="$4"

  echo "$content" | aws s3 cp - "s3://${artifacts_bucket}/${s3_key}" \
    --content-type "${content_type}" || {
    echo "WARN: Failed to upload to S3 key ${s3_key}"
    return 1
  }
}

# --- GitHub Comment Management ---
post_comment() {
  local issue_number="$1"
  local repo="$2"
  local comment_body="$3"

  gh issue comment "${issue_number}" -R "${repo}" --body "${comment_body}" >/dev/null 2>&1 || true
}

# --- Label Management ---
apply_labels() {
  local issue_number="$1"
  local repo="$2"
  local labels_to_add=("${@:3}")

  for label in "${labels_to_add[@]}"; do
    gh issue edit "${issue_number}" --add-label "${label}" -R "${repo}" >/dev/null 2>&1 || true
  done
}

remove_labels() {
  local issue_number="$1"
  local repo="$2"
  local labels_to_remove=("${@:3}")

  for label in "${labels_to_remove[@]}"; do
    gh issue edit "${issue_number}" --remove-label "${label}" -R "${repo}" >/dev/null 2>&1 || true
  done
}

set_signal_label() {
  local issue_number="$1"
  local repo="$2"
  local trigger_label="$3"
  local target_label="$4"
  local signal_labels=("${@:5}")

  for label in "${signal_labels[@]}"; do
    if [ "${label}" != "${target_label}" ]; then
      gh issue edit "${issue_number}" --remove-label "${label}" -R "${repo}" >/dev/null 2>&1 || true
    fi
  done

  gh issue edit "${issue_number}" --remove-label "${trigger_label}" -R "${repo}" >/dev/null 2>&1 || true
  gh issue edit "${issue_number}" --add-label "${target_label}" -R "${repo}" >/dev/null 2>&1 || true
}

# --- Metadata Management ---
update_task_metadata() {
  local metadata_json="$1"
  local s3_key="$2"
  local artifacts_bucket="$3"

  upload_artifact_from_string "$metadata_json" "$s3_key" "application/json" "$artifacts_bucket"
}

# --- Git Repository Setup ---
clone_and_setup_repo() {
  local repo_slug="$1"
  local github_token="$2"
  local target_dir="${3:-.}"

  echo "Cloning ${repo_slug}..."
  gh repo clone "${repo_slug}" "${target_dir}" -- --depth=50

  cd "${target_dir}"

  # Fix git remote URL for push authentication
  git remote set-url origin "https://x-access-token:${github_token}@github.com/${repo_slug}.git"

  # Install git hooks (pre-commit, pre-push)
  echo "Setting up git hooks..."
  if [ -f ".husky/pre-commit" ] && [ -f ".husky/pre-push" ]; then
    echo "Git hooks found, installing..."
    # Make hooks executable
    chmod +x .husky/pre-commit .husky/pre-push
    # Configure git to use hooks from .husky directory
    git config core.hooksPath .husky || true
    echo "Git hooks installed successfully"
  else
    echo "WARNING: .husky hooks not found in repository"
  fi
}

# Source should work when sourced from different directories
export -f setup_github_auth
export -f upload_artifact
export -f upload_artifact_from_string
export -f post_comment
export -f apply_labels
export -f remove_labels
export -f set_signal_label
export -f update_task_metadata
export -f clone_and_setup_repo
