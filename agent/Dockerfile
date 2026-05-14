FROM node:20

RUN apt-get update && apt-get install -y git jq curl unzip && rm -rf /var/lib/apt/lists/*

# Install yq (Go) for YAML parsing in persona-runner.sh
RUN curl -sL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 \
      -o /usr/local/bin/yq \
  && chmod +x /usr/local/bin/yq

# Install AWS CLI v2 (needed for S3 artifact uploads)
RUN curl -sf "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/awscliv2.zip /tmp/aws

# Install gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

RUN useradd --create-home --shell /bin/bash agent \
  && mkdir -p /work \
  && chown -R agent:agent /work /home/agent

WORKDIR /work

# Copy shared libraries
COPY lib/common.sh /lib/common.sh
COPY lib/orchestrate-lint.sh /lib/orchestrate-lint.sh
COPY lib/lint-loop.sh /lib/lint-loop.sh
COPY lib/persona-runner.sh /lib/persona-runner.sh
RUN chmod +x /lib/common.sh /lib/orchestrate-lint.sh /lib/lint-loop.sh /lib/persona-runner.sh

# Persona profiles (governance CAB/ARB/CTO/Board, plus future role templates).
# YAML defines metadata (target issue, tools, sources, IAM); MD is the prompt.
# Loaded at runtime by /lib/persona-runner.sh when TASK_PAYLOAD.persona_id is set.
COPY agents/ /agents/
RUN chmod -R a+r /agents

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER agent

ENTRYPOINT ["/entrypoint.sh"]
