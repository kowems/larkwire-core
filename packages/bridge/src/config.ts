/**
 * 桥本地配置 ~/.larkwire/config.json（含私钥 → 0600）。
 * 设备即身份：X25519 密钥对在首次运行时生成。
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, renameSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { generateKeyPair, u8ToB64, b64ToU8, deviceIdFromKey } from "@larkwire/protocol";

export interface PairedPeer {
  deviceId: string;
  publicKey: string; // base64
  name: string;
  pairedAt: number;
}

export interface BridgeConfig {
  deviceId: string;
  publicKey: string; // base64
  secretKey: string; // base64 —— 永不出本机
  name: string;
  relay: string; // ws(s)://... 官方云默认 wss://larkwire.kowems.site/ws
  pairPageBase: string; // 落地页 base，默认 https://larkwire.kowems.site/pair
  paired: PairedPeer[];
}

export const DEFAULT_RELAY = "wss://larkwire.kowems.site/ws";
export const DEFAULT_PAIR_PAGE = "https://larkwire.kowems.site/pair";

export function larkwireDir(): string {
  return join(homedir(), ".larkwire");
}

export function configPath(): string {
  return join(larkwireDir(), "config.json");
}

export function stateDir(): string {
  return join(larkwireDir(), "state");
}

export function loadConfig(): BridgeConfig | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as BridgeConfig;
}

export function saveConfig(cfg: BridgeConfig): void {
  mkdirSync(larkwireDir(), { recursive: true });
  const p = configPath();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  try {
    chmodSync(p, 0o600);
  } catch { /* Windows 宽容 */ }
}

/**
 * 环境变量中继覆盖（进程级、不落盘）：e2e 用隔离 HOME 起本地中继、自托管部署都靠它，
 * 优先级在显式 relayOverride（pair 流程的 --relay，会持久化）之下。
 */
export function envRelayUrl(): string | undefined {
  const v = process.env.LARKWIRE_RELAY_URL;
  return v && v.trim() ? v.trim() : undefined;
}

/** 首次运行：生成设备身份 */
export function loadOrCreateConfig(relayOverride?: string): BridgeConfig {
  const env = envRelayUrl();
  const existing = loadConfig();
  if (existing) {
    if (relayOverride && existing.relay !== relayOverride) {
      existing.relay = relayOverride;
      saveConfig(existing);
    } else if (!relayOverride && env && existing.relay !== env) {
      existing.relay = env; // 进程级覆盖，不回写
    }
    return existing;
  }
  const kp = generateKeyPair();
  const publicKey = u8ToB64(kp.publicKey);
  const cfg: BridgeConfig = {
    deviceId: deviceIdFromKey(publicKey),
    publicKey,
    secretKey: u8ToB64(kp.secretKey),
    name: hostname().replace(/\.(local|lan)$/, ""),
    relay: relayOverride ?? env ?? DEFAULT_RELAY,
    pairPageBase: DEFAULT_PAIR_PAGE,
    paired: [],
  };
  saveConfig(cfg);
  return cfg;
}

export function configKeyPair(cfg: BridgeConfig): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return { publicKey: b64ToU8(cfg.publicKey), secretKey: b64ToU8(cfg.secretKey) };
}
