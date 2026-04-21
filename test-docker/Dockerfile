FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    tmux \
    curl \
    grep \
    coreutils \
    procps \
    lsof \
    python3 \
    ca-certificates \
    jq \
    sudo \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Non-root user so `claude --dangerously-skip-permissions` doesn't refuse.
RUN useradd -m -s /bin/bash runner

WORKDIR /workspace

COPY promptctl-open-dispatch.sh /home/runner/.claude/hooks/promptctl-open-dispatch.sh
COPY mock-promptctl-server.py /workspace/mock-promptctl-server.py
COPY run-test.sh /workspace/run-test.sh
COPY bashrc /home/runner/.bashrc
# Pre-seed onboarding so `claude` jumps straight to the prompt instead of
# walking through theme + login menus.
COPY claude-config.json /home/runner/.claude.json

RUN chown -R runner:runner /home/runner /workspace \
 && chmod +x /home/runner/.claude/hooks/promptctl-open-dispatch.sh \
             /workspace/run-test.sh

USER runner
ENV HOME=/home/runner
ENV TERM=xterm-256color
ENV ANTHROPIC_API_KEY=sk-test-not-a-real-key

CMD ["/workspace/run-test.sh"]
