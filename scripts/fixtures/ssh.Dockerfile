FROM python:3.12.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server && rm -rf /var/lib/apt/lists/* && useradd -m -s /bin/bash trainer && passwd -d trainer && mkdir -p /run/sshd /home/trainer/.ssh && chmod 700 /home/trainer/.ssh
COPY authorized_keys /home/trainer/.ssh/authorized_keys
RUN chown -R trainer:trainer /home/trainer/.ssh && chmod 600 /home/trainer/.ssh/authorized_keys && printf '\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers trainer\nPidFile /run/sshd.pid\n' >> /etc/ssh/sshd_config
EXPOSE 22
CMD ["sh", "-c", "/usr/sbin/sshd -D -e & wait"]
