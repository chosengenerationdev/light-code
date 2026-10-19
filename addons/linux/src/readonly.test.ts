import { describe, expect, it } from 'vitest'

import { checkReadOnly, splitPipeline } from './readonly.js'

/**
 * The promise is that nothing the add-on sends can change a machine. Both halves are pinned: what an
 * investigation needs must pass (a check nobody can work with gets switched off), and every way of
 * writing, chaining or never finishing must not.
 */
const ok = (command: string, extra: string[] = []): boolean => checkReadOnly(command, extra).ok

describe('what an investigation needs', () => {
  it.each([
    'df -h',
    'free -m',
    'uptime',
    'ps aux',
    'ps -ef | grep java | grep -v grep',
    'tail -n 200 /var/log/app/server.log',
    "grep -n 'ERROR' /var/log/app/server.log | tail -n 50",
    "grep -E 'timeout$|refused' /var/log/messages",
    'ls -la /var/log/app',
    'du -sh /var/log/* | sort -h | tail -n 10',
    'journalctl -u nginx --since "1 hour ago" --no-pager',
    'systemctl status nginx',
    'ss -tlnp',
    'ip addr',
    'find /var/log -name "*.log" -mtime -1',
    'cat /etc/os-release',
    'docker ps -a',
    'docker logs --tail 100 web',
    'kubectl get pods -n prod',
    'top -b -n 1 | head -n 20',
    'date +%F',
    'crontab -l',
    'zgrep timeout /var/log/app/server.log.1.gz',
    'wc -l /var/log/app/server.log',
    'sort -u names.txt | uniq -c',
  ])('allows %s', (command) => {
    expect(checkReadOnly(command)).toEqual({ ok: true })
  })
})

describe('what could change a machine, chain or never end', () => {
  it.each([
    ['rm -rf /tmp/x', 'not on the read-only list'],
    ['ls; rm -rf /', 'chains'],
    ['ls && reboot', 'chains'],
    ['ls || reboot', '||'],
    ['cat a > b', 'chains'],
    ['cat < /etc/passwd', 'chains'],
    ['echo $(reboot)', 'chains'],
    ['echo `reboot`', 'chains'],
    ['echo "$(reboot)"', 'double quotes'],
    ['ls\nreboot', 'more than one line'],
    ['sudo cat /etc/shadow', 'not on the read-only list'],
    ['/tmp/evil/cat x', 'bare name'],
    ['X=1 ls', 'bare name'],
    ['find / -name x -delete', '-delete'],
    ['find / -exec rm {} ;', 'chains'],
    ['find / -exec rm {} \\;', '-exec'],
    ['sort -o /etc/passwd x', '-o'],
    ['sort --output=/etc/passwd x', '--output'],
    ['uniq a b', 'output file'],
    ['tail -f /var/log/x', '-f'],
    ['tail -n 10 -F x', '-F'],
    ['journalctl --vacuum-size=1M', '--vacuum-size'],
    ['journalctl -f', '-f'],
    ['dmesg -c', '-c'],
    ['date -s "2020-01-01"', 'sets the clock'],
    ['hostname evil', 'no arguments'],
    ['systemctl restart nginx', 'only status'],
    ['ip link set eth0 down', 'not read-only'],
    ['docker rm web', 'only ps'],
    ['docker logs -f web', 'never ends'],
    ['kubectl delete pod x', 'only get'],
    ['kubectl get pods -w', 'never ends'],
    ['top', 'top needs'],
    ['ping example.com', 'never ends'],
    ['env rm -rf /', 'no arguments'],
    ['crontab -r', 'only crontab -l'],
    ['ss -K dst 1.2.3.4', '-K'],
    ['xxd a b', 'output file'],
    ['awk \'{system("reboot")}\' x', 'not on the read-only list'],
    ['sed -i s/a/b/ x', 'not on the read-only list'],
    ['xargs rm', 'not on the read-only list'],
    ["echo 'unclosed", 'unclosed quote'],
    ['ls |', 'empty command'],
  ])('refuses %s', (command, why) => {
    const verdict = checkReadOnly(command)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok ? '' : verdict.reason).toContain(why)
  })
})

describe('the details', () => {
  it('keeps $ literal inside single quotes, where the shell does not expand it', () => {
    expect(splitPipeline("grep 'a$' f | wc -l")).toEqual([['grep', 'a$', 'f'], ['wc', '-l']])
  })

  it('accepts a program the user added on the tab, with any arguments', () => {
    expect(ok('my-status --all')).toBe(false)
    expect(ok('my-status --all', ['my-status'])).toBe(true)
    expect(ok('my-status --all; reboot', ['my-status'])).toBe(false)
  })

  it('checks every program in a pipe', () => {
    expect(ok('cat x | rm y')).toBe(false)
  })
})
