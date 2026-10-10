/**
 * 中继连接（桥侧 WS 客户端）：hello/auth 握手 + 自动重连 + 信封收发。
 * E2E：发出去的 body 在离开本机前加密，中继只见信封头。
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import nacl from "tweetnacl";
import {
  T,
  makeEnvelope,
  u8ToB64,
  b64ToU8,
  deriveSharedKey,
  encryptBody,
  decryptBody,
  type Envelope,
  type MessageType,
} from "@larkwire/protocol";

export interface PeerKeys {
  deviceId: string;
  publicKey: Uint8Array;
}

// 心跳（M3）：中继 25s 发 ping，这里即收即回 pong；90s 任何帧都没收到 = 连接假活
// （TCP 半开 / NAT 静默老化）——terminate 触发 close 链，现有退避重连接管
const HEARTBEAT_CHECK_MS = 30_000; // 看门狗巡查间隔（ping 25s 一来，错过一个还有下个窗口）
const PONG_TIMEOUT_MS = 90_000; // 与中继同口径

export class RelayConnection extends EventEmitter {
  private ws?: WebSocket;
  private relayUrl: string;
  private hello: { deviceId: string; publicKey: string; name: string };
  private secretKey: Uint8Array;
  private reconnectDelay = 1000;
  private closedByUser = false;
  private readyFlag = false;
  private lastSeenAt = Date.now(); // 任何入站帧都刷新——心跳判活唯一口径

  constructor(opts: {
    relayUrl: string;
    deviceId: string;
    publicKey: Uint8Array;
    secretKey: Uint8Array;
    name: string;
  }) {
    super();
    this.relayUrl = opts.relayUrl;
    this.secretKey = opts.secretKey;
    this.hello = { deviceId: opts.deviceId, publicKey: u8ToB64(opts.publicKey), name: opts.name };
    // 心跳看门狗：closedByUser / 非 OPEN 状态不动作（4000 被踢后 ws 已关，天然不看门狗，
    // 现有「被踢不重连」纪律不变）；terminate 后 close 事件里的退避重连接管
    setInterval(() => {
      if (this.closedByUser) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const silentMs = Date.now() - this.lastSeenAt;
      if (silentMs > PONG_TIMEOUT_MS) {
        this.emit("warn", `心跳超时（${Math.round(silentMs / 1000)}s 无帧）→ 主动断线重连`);
        this.ws.terminate();
      }
    }, HEARTBEAT_CHECK_MS).unref();
  }

  get ready(): boolean {
    return this.readyFlag;
  }

  connect(): void {
    this.closedByUser = false;
    this.openSocket();
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }

  private openSocket(): void {
    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;
    this.readyFlag = false;

    ws.on("open", () => {
      ws.send(JSON.stringify({ kind: "hello", v: 1, ...this.hello }));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      this.lastSeenAt = Date.now();
      let msg: { kind?: string; type?: string; ts?: number };
      try {
        msg = JSON.parse(data.toString()) as { kind?: string; type?: string; ts?: number };
      } catch {
        return;
      }

      // 心跳应答（M3）：中继 25s 一探，ts 原样带回（对账用）。ping 只发给 authed 连接，
      // 但拦截放在握手分支前无副作用——早回 pong 不会通过中继的未认证丢弃关
      if (msg.kind === "ping") {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ kind: "pong", ts: msg.ts ?? Date.now() }));
        }
        return;
      }

      if (msg.kind === "auth.challenge") {
        const { ephemeralPublicKey, cipher } = msg as unknown as { ephemeralPublicKey: string; cipher: string };
        const packed = b64ToU8(cipher);
        const boxNonce = packed.slice(0, nacl.box.nonceLength);
        const ct = packed.slice(nacl.box.nonceLength);
        const nonce = nacl.box.open(ct, boxNonce, b64ToU8(ephemeralPublicKey), this.secretKey);
        if (!nonce) {
          this.emit("error", new Error("auth challenge 解密失败"));
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ kind: "auth.response", nonce: u8ToB64(nonce) }));
        return;
      }
      if (msg.kind === "auth.ok") {
        this.readyFlag = true;
        this.reconnectDelay = 1000;
        this.emit("ready");
        return;
      }
      if (msg.kind === "auth.error") {
        this.emit("error", new Error(`中继鉴权失败：${(msg as { reason?: string }).reason}`));
        ws.close();
        return;
      }
      if (msg.kind) return; // 其他控制消息忽略

      this.emit("envelope", msg as unknown as Envelope);
    });

    ws.on("close", (code, reason) => {
      this.readyFlag = false;
      this.emit("close", code, reason.toString());
      if (code === 4000) {
        // 被中继踢下：同设备身份有更新的连接上线。此刻重连只会把对方踢回来、
        // 无限互踢（pair+watch 同跑时的乒乓球事故 2026-09-16）——交给调用方明示退出。
        this.emit("kicked", reason.toString());
        return;
      }
      if (!this.closedByUser) {
        setTimeout(() => this.openSocket(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      }
    });

    ws.on("error", (err) => {
      this.emit("wsError", err); // close 事件会跟在后面，重连逻辑在那
    });
  }

  private sendEnvelope(env: Envelope): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(env));
    else this.emit("warn", `发送时连接未就绪，丢弃 ${env.type}`);
  }

  /** 明文 body（pair 引导期 / 对中继的内部消息） */
  sendPlain(to: string, type: MessageType, body: unknown, seq = 0): void {
    this.sendEnvelope(makeEnvelope(type, this.hello.deviceId, to, seq, JSON.stringify(body)));
  }

  /**
   * E2E 密文 body（业务消息全走这里）；
   * hint=推送文案模板标签（M3，明文可选）；sid=通知直达会话 id（明文可选）；
   * proj=项目目录 basename / tool=权限工具名（推送增强，明文可选，见 Envelope.proj/tool）
   */
  sendSecure(
    peer: PeerKeys,
    type: MessageType,
    body: unknown,
    seq: number,
    hint?: string,
    sid?: string,
    proj?: string,
    tool?: string,
  ): void {
    const shared = deriveSharedKey(peer.publicKey, this.secretKey);
    const cipher = encryptBody(shared, body);
    this.sendEnvelope(makeEnvelope(type, this.hello.deviceId, peer.deviceId, seq, cipher, hint, sid, proj, tool));
  }

  /** 解密来自某 peer 的信封 body */
  decryptFrom(peer: PeerKeys, env: Envelope): unknown {
    const shared = deriveSharedKey(peer.publicKey, this.secretKey);
    return decryptBody(shared, env.body);
  }
}
