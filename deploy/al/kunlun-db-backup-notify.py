#!/usr/bin/python3
"""Email that a Kunlun database backup unit on al failed.

Installed as /usr/local/sbin/kunlun-db-backup-notify. kunlun-db-backup@.service lists
kunlun-db-backup-notify@%n.service under OnFailure=, so systemd runs this only after a backup unit fails or times out;
a successful backup never sends mail. The SMTP account and recipients live in /etc/kunlun-db-backup-notify.conf (root,
mode 600; format in kunlun-db-backup-notify.conf.example), never in the repository. al has no local MTA and Aliyun
blocks outbound port 25, so this talks to the mail provider directly on port 465 or 587. See deploy/al/README.md.
Usage: kunlun-db-backup-notify <failed unit>   (e.g. kunlun-db-backup@prod.service)
"""
import collections
import os
import smtplib
import socket
import ssl
import subprocess
import sys
import textwrap
import time
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid, parseaddr

CONF = "/etc/kunlun-db-backup-notify.conf"
LOG = "/var/log/kunlun-db-backup.log"
KEYS = ("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM", "MAIL_TO")
REQUIRED = ("SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "MAIL_TO")
LOG_LINES = 10
JOURNAL_LINES = 20
RETRY_DELAYS = (30, 60)  # seconds before the second and the third attempt
SMTP_TIMEOUT = 30


def read_config():
    """Parse KEY=value lines. Errors name the file, line or key but never echo a value."""
    with open(CONF, encoding="utf-8") as f:
        st = os.fstat(f.fileno())
        if st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise ValueError(f"{CONF} must belong to root and have mode 600")
        conf = dict.fromkeys(KEYS, "")
        for number, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, sep, value = (part.strip() for part in line.partition("="))
            if not sep or key not in KEYS:
                raise ValueError(f"{CONF} line {number}: expected KEY=value with KEY one of {', '.join(KEYS)}")
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            conf[key] = value
    conf["MAIL_TO"] = [addr.strip() for addr in conf["MAIL_TO"].split(",") if addr.strip()]
    missing = [key for key in REQUIRED if not conf[key]]
    if missing:
        raise ValueError(f"{CONF} has no value for {', '.join(missing)}")
    conf["SMTP_PORT"] = int(conf["SMTP_PORT"] or 465)
    return conf


def run(*args):
    """Output of a read-only command, or why there is none: the mail must go out even if this part fails."""
    try:
        done = subprocess.run(args, capture_output=True, text=True, errors="replace", timeout=30, check=False)
    except (OSError, subprocess.SubprocessError) as e:
        return f"({args[0]}: {e})"
    return (done.stdout or done.stderr).rstrip()


def tail(path, count):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return "".join(collections.deque(f, count)).rstrip()
    except OSError as e:
        return f"({path}: {e.strerror})"


def compose(unit, conf):
    host = socket.gethostname()
    props = {}
    for line in run("systemctl", "show", unit, "--property=Result,ExecMainStatus,ExecMainExitTimestamp").splitlines():
        key, _, value = line.partition("=")
        props[key] = value
    result = f"{props.get('Result') or '?'}（ExecMainStatus={props.get('ExecMainStatus') or '?'}）"
    when = props.get("ExecMainExitTimestamp") or time.strftime("%Y-%m-%d %H:%M:%S %Z")
    log_tail = textwrap.indent(tail(LOG, LOG_LINES), "  ")
    journal = textwrap.indent(
        run("journalctl", "--unit", unit, "--lines", str(JOURNAL_LINES), "--output", "short-iso", "--no-pager"), "  ")

    name, sender = parseaddr(conf["MAIL_FROM"] or conf["SMTP_USER"])
    msg = EmailMessage()
    msg["Subject"] = f"数据库备份失败：{unit}（主机 {host}）"
    msg["From"] = formataddr((name or "al 数据库备份", sender))
    msg["To"] = ", ".join(conf["MAIL_TO"])
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=sender.rpartition("@")[2] or host)
    msg.set_content(f"""\
{host} 上的 {unit} 失败了。

单元：{unit}
主机：{host}
结果：{result}
时间：{when}

{LOG} 最后 {LOG_LINES} 行：
{log_tail}

journalctl -u {unit} 最后 {JOURNAL_LINES} 行：
{journal}

排查：ssh al 'journalctl -u {unit} -n 100 --no-pager'
修好后重跑：ssh al 'systemctl start {unit} && tail -n 1 {LOG}'

这封邮件由 al 上的 kunlun-db-backup-notify@{unit}.service 发出，说明见仓库 deploy/al/README.md。
""", cte="base64")
    return msg, sender


def send(msg, sender, conf):
    """Deliver one message; returns the recipients the server refused while accepting the others."""
    context = ssl.create_default_context()
    if conf["SMTP_PORT"] == 465:
        server = smtplib.SMTP_SSL(conf["SMTP_HOST"], 465, timeout=SMTP_TIMEOUT, context=context)
    else:
        server = smtplib.SMTP(conf["SMTP_HOST"], conf["SMTP_PORT"], timeout=SMTP_TIMEOUT)
    with server:
        if conf["SMTP_PORT"] != 465:
            server.starttls(context=context)
        server.login(conf["SMTP_USER"], conf["SMTP_PASSWORD"])
        return server.send_message(msg, from_addr=sender, to_addrs=conf["MAIL_TO"])


def permanent(error):
    """Retrying does not fix a 5xx reply (wrong password, refused sender or recipient, rejected message) or a bug."""
    if isinstance(error, smtplib.SMTPRecipientsRefused) or not isinstance(error, OSError):
        return True
    return isinstance(error, smtplib.SMTPResponseException) and error.smtp_code >= 500


def describe(error):
    return f"{type(error).__name__}: {error}".replace("\n", " ")


def main():
    if len(sys.argv) != 2:
        print("usage: kunlun-db-backup-notify <failed unit>", file=sys.stderr)
        return 2
    os.umask(0o077)
    unit = sys.argv[1]
    env_name = unit.removeprefix("kunlun-db-backup@").removesuffix(".service")

    def log(text):
        print(text)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {env_name} NOTIFY {text}\n")

    # The exact name: al's journal is ~3G, and a glob such as -u 'kunlun-db-backup-notify@*' scans all of it.
    details = f"details: journalctl -u kunlun-db-backup-notify@{unit}.service"

    try:
        conf = read_config()
        msg, sender = compose(unit, conf)
    except Exception as e:  # every failure must leave a line in the log
        log(f"FAILED unit={unit} {describe(e)}")
        return 1
    for attempt, delay in enumerate((0, *RETRY_DELAYS), 1):
        time.sleep(delay)
        try:
            refused = send(msg, sender, conf)
        except Exception as e:  # smtplib and ssl errors are OSErrors; anything else is a bug and also final
            error = describe(e)
            print(f"attempt {attempt}: {error}", file=sys.stderr)
            if permanent(e):
                break
            continue
        if refused:
            print(f"refused by the server: {refused}", file=sys.stderr)
            log(f"FAILED unit={unit} {len(refused)} of {len(conf['MAIL_TO'])} recipients refused; {details}")
            return 1
        log(f"sent unit={unit} recipients={len(conf['MAIL_TO'])} attempt={attempt}")
        return 0
    log(f"FAILED unit={unit} {error}; {details}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
