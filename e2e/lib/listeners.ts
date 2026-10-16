import fs from "node:fs";

export interface Listeners {
  /** "ip:port" of every TCP socket in LISTEN state, IPv4 as dotted, IPv6 as hex. */
  tcp: string[];
  /** Bound UDP sockets. */
  udp: string[];
  /** Filesystem paths of listening unix sockets. */
  unix: string[];
}

function inodes(pid: number): Set<string> {
  const out = new Set<string>();
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    try {
      const m = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/);
      if (m) out.add(m[1]!);
    } catch {
      /* fd closed meanwhile */
    }
  }
  return out;
}

function ipv4(hex: string): string {
  const b = Buffer.from(hex, "hex");
  return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`;
}

function inet(file: string, state: string, mine: Set<string>): string[] {
  const out: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== state || !mine.has(f[9]!)) continue;
    const [addr = "", port = "0"] = f[1]!.split(":");
    out.push(`${addr.length === 8 ? ipv4(addr) : addr}:${parseInt(port, 16)}`);
  }
  return out;
}

/** The sockets a process is listening on (Linux /proc). The process must be ours. */
export function listeners(pid: number): Listeners {
  const mine = inodes(pid);
  const unix: string[] = [];
  for (const line of fs.readFileSync("/proc/net/unix", "utf8").split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    // Num RefCount Protocol Flags Type St Inode Path ; Flags 00010000 = accepting
    if (f.length >= 8 && mine.has(f[6]!) && f[3] === "00010000") unix.push(f[7]!);
  }
  return {
    tcp: [...inet("/proc/net/tcp", "0A", mine), ...inet("/proc/net/tcp6", "0A", mine)],
    udp: [...inet("/proc/net/udp", "07", mine), ...inet("/proc/net/udp6", "07", mine)],
    unix,
  };
}
