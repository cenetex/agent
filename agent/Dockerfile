FROM agent:base

COPY entrypoint.sh /entrypoint.sh
COPY lib/common.sh /lib/common.sh
RUN chmod +x /entrypoint.sh /lib/common.sh

USER agent

ENTRYPOINT ["/entrypoint.sh"]
