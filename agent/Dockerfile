ARG NODE_IMAGE=node:20.20.2-bookworm-slim
FROM ${NODE_IMAGE}

ARG CODEX_CLI_VERSION=0.142.3
ARG AWS_CLI_VERSION=2.34.46
ARG GH_CLI_VERSION=2.92.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git jq curl unzip ca-certificates \
    python3 python3-pip python3-venv python3-pytest python3-tk python-is-python3 xvfb \
  && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2 (needed for S3 artifact uploads)
RUN curl -sf "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWS_CLI_VERSION}.zip" -o /tmp/awscliv2.zip \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/awscliv2.zip /tmp/aws

# Install gh CLI
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tar.gz \
  && tar -xzf /tmp/gh.tar.gz -C /tmp \
  && install -m 0755 "/tmp/gh_${GH_CLI_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
  && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_CLI_VERSION}_linux_amd64"

# Install Codex CLI
RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}"

RUN useradd --create-home --shell /bin/bash agent \
  && mkdir -p /work \
  && chown -R agent:agent /work /home/agent

WORKDIR /work

# Copy shared libraries
COPY lib/common.sh /lib/common.sh
COPY lib/orchestrate-lint.sh /lib/orchestrate-lint.sh
COPY lib/lint-loop.sh /lib/lint-loop.sh
RUN chmod +x /lib/common.sh /lib/orchestrate-lint.sh /lib/lint-loop.sh

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER agent

ENTRYPOINT ["/entrypoint.sh"]
