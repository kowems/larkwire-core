/**
 * 信封协议（架构 §2.1）：路由元数据明文 + body 密文。
 * 中继只看 {type, from, to, 字节数}，永远打不开 body。
 */
import { nowTs, uuid } from "./crypto.js";

export interface Envelope {
  v: 1;
  type: MessageType;
  id: string;
  ts: number;
  from: string; // dev_xxx
  to: string; // dev_xxx | grp_xxx | "relay"
  seq: number; // 每会话单调递增；看模式 = 转录字节偏移推导
  body: string; // base64 密文（pair.* 引导期例外，见下）
  // M3 推送：顶层明文可选提示（"permission"/"runDone"）——中继路由时凭它选推送文案模板，
  // 无需解密 body。旧端忽略未知字段 = 向后兼容
  hint?: string;
  // 通知直达（第一刀补洞 C）：会话 id 明文可选——中继把它塞进个推 payload，点通知直落
  // 该会话流页（hint 同款口径：明文不涉密，body 仍 E2E；旧端忽略 = 向后兼容）
  sid?: string;
  // 推送增强（2026-10-08 Eric 拍板，修订 2026-09-21「工具名不出端」口径）：
  // proj = 项目目录名（cwd 最后一段，中继渲染进推送标题/正文）；tool = 权限工具名（仅 permission）。
  // 红线：完整路径/命令/输入/会话标题永不出端；桥侧只填 basename，中继再消毒。
  // 旧端忽略未知字段 = 向后兼容（缺字段时中继回退通用文案）
  proj?: string;
  tool?: string;
}

/** 消息类型清单（架构 §2.2 v1 + M0 落地增补 session.subscribe / stream.ack） */
export const T = {
  // 配对（offer/accept/error/revoke body 明文 JSON：握手引导期双方尚无共享密钥，内容只有 token+公钥；
  // confirm 例外 = E2E 密文，解开即证明双方密钥推导一致）
  PairOffer: "pair.offer",
  PairOfferAck: "pair.offer.ack", // M0 增补：中继确认 offer 已登记，桥收到后再亮二维码（拒绝静默失败）
  PairAccept: "pair.accept",
  PairAcceptAck: "pair.accept.ack", // M0 增补：中继把 offer 里的桥公钥/桥名回给手机（手机凭 QR 里的 fp 校验真伪，再推导共享密钥）
  PairConfirm: "pair.confirm",
  PairError: "pair.error",
  PairRevoke: "pair.revoke",
  PairStatus: "pair.status", // #83 增补：中继鉴权后下发当前全部 active 对端——连接即对账，根治离线撤销裂脑
  // 会话
  SessionRegister: "session.register",
  SessionUpdate: "session.update",
  SessionEnd: "session.end",
  SessionSubscribe: "session.subscribe", // M0 增补：App 打开会话页 → 桥回 snapshot 再续 delta
  SessionList: "session.list", // M0 增补：App 重连就绪后拉全量会话列表（注册是纯推送，刷新/重连会丢）→ 桥重发 register
  PermissionList: "permission.list", // M3 增补：App 每次 ws ready 后拉一次挂起权限卡（补缝隙：iOS 后台 ≤90s 回前台时 presence 无转换、permissionReplay 不触发，直路由丢的卡靠拉取兜底；App 按 requestId 去重）
  // 流
  StreamDelta: "stream.delta",
  StreamSnapshot: "stream.snapshot",
  StreamAck: "stream.ack", // M0 增补：App 批量回 lastSeq，桥记 lastAck
  // 输入（M1 控模式）
  InputSubmit: "input.submit",
  InputAck: "input.ack", // 桥回执：受理/拒收（拒收带原因，如「电脑端正活跃」）
  // 接管（M1.5）：手机「抢夺控制权」——桥四重验证后 SIGTERM 杀掉电脑端持有会话的进程，
  // 占用闸门打开，App 自动重发被拒的话。即时动作：不进离线队列、body 默认 E2E 密文
  SessionTakeover: "session.takeover",
  SessionTakeoverAck: "session.takeover.ack",
  // 控制权归属（A+B，2026-09-19 Eric 拍板）：owner=桥推送持有者状态（注册表 watcher 探测变化 /
  // 订阅时回当前值）；release=手机「还回电脑」（杀进行中的 run，幂等），ack 回执
  SessionOwner: "session.owner",
  SessionRelease: "session.release",
  SessionReleaseAck: "session.release.ack",
  // 权限接力（M1）：桥的 resume 子进程递出 can_use_tool → 转发手机 → 手机回批 → 桥写回子进程
  PermissionRequest: "permission.request",
  PermissionRespond: "permission.respond",
  PermissionResolve: "permission.resolve", // 桥告知手机：该请求已了结（答复/取消/回合结束/进程死了），卡片撤下。M3 起桥不再产 "expired"（Eric 拍板 2026-09-21：废 120s 超时自动拒绝，卡无限期等人点）
  // 群（M2）
  GroupRoster: "group.roster",
  GroupMessage: "group.message",
  // 在场
  PresenceOnline: "presence.online",
  PresenceOffline: "presence.offline",
  // 通知（M3；level 明文）
  NotifyRequest: "notify.request",
  // 计量
  MeterAck: "meter.ack",
} as const;
export type MessageType = (typeof T)[keyof typeof T];

/** body 为明文 JSON 的类型（中继可读，其余一律 E2E 密文——pair.confirm 也是密文） */
export const PLAINTEXT_BODY_TYPES: ReadonlySet<string> = new Set([
  T.PairOffer,
  T.PairOfferAck,
  T.PairAccept,
  T.PairAcceptAck,
  T.PairError,
  T.PairRevoke,
  T.PairStatus, // 中继单方构造下发，设备侧验 from==="relay"
  T.PresenceOnline, // 中继代发（它无法持有任何共享密钥），内容 = 在线状态，本属明文集合
  T.PresenceOffline,
]);

/**
 * 中继离线队列只保通知/在场/会话/撤销类小消息（架构 §2.4 修订；#83 增补 pair.revoke）：
 * 流式内容不进中继队列（50 条几秒就冲掉），靠桥侧 seq/lastAck 重放。
 */
export const QUEUEABLE_TYPES: ReadonlySet<string> = new Set([
  T.NotifyRequest,
  T.PairRevoke, // #83：离线撤销必须送达（body 明文，离线方无桥密钥也能读），覆盖离线 ≤10 分钟
  T.PresenceOnline,
  T.PresenceOffline,
  T.SessionRegister,
  T.SessionUpdate,
  T.SessionEnd,
]);

export const MAX_ENVELOPE_BYTES = 64 * 1024; // 单信封上限（评审硬伤①修订）
export const OFFLINE_QUEUE_MAX = 50; // 每设备离线队列上限（先到先丢老的）
export const OFFLINE_QUEUE_TTL_MS = 10 * 60 * 1000; // 10 分钟
export const PAIR_TOKEN_TTL_MS = 10 * 60 * 1000; // 配对 token 10 分钟（架构 §2.3.1）

export function makeEnvelope(
  type: MessageType,
  from: string,
  to: string,
  seq: number,
  body: string,
  hint?: string, // M3：推送文案模板标签（明文，见 Envelope.hint）；undefined 则不序列化该字段
  sid?: string, // 通知直达：会话 id（明文可选，notify.request 专属，见 Envelope.sid）
  proj?: string, // 推送增强：项目目录 basename（明文可选，见 Envelope.proj）
  tool?: string, // 推送增强：权限工具名（明文可选，见 Envelope.tool）
): Envelope {
  const env: Envelope = { v: 1, type, id: uuid(), ts: nowTs(), from, to, seq, body };
  if (hint !== undefined) env.hint = hint;
  if (sid !== undefined) env.sid = sid;
  if (proj !== undefined) env.proj = proj;
  if (tool !== undefined) env.tool = tool;
  return env;
}

// ---------- 中继控制通道（hello/auth，非信封，连接建立期的明文握手） ----------

/** 设备连接后第一条消息：自报家门 */
export interface HelloMsg {
  kind: "hello";
  v: 1;
  deviceId: string; // dev_xxx
  publicKey: string; // base64 X25519 公钥（首次连接即注册，中继记 devices 表）
  name?: string; // 设备名（"Eric 的 MacBook"），仅展示
}

/** 中继挑战：用设备公钥加密随机 nonce，能解开 = 持有私钥 */
export interface AuthChallengeMsg {
  kind: "auth.challenge";
  ephemeralPublicKey: string; // base64，中继临时密钥对公钥
  cipher: string; // base64 box(nonce)
}

export interface AuthResponseMsg {
  kind: "auth.response";
  nonce: string; // base64 解出的 nonce 原文回传
}

export interface AuthOkMsg {
  kind: "auth.ok";
  deviceId: string;
}

export interface AuthErrorMsg {
  kind: "auth.error";
  reason: string;
}

/**
 * 心跳（M3，应用层单机制）：中继每 25s 向在线连接发 ping，端立即回 pong（ts 原样带回）。
 * 双端各自 90s 无帧即行动：中继 terminate 踢僵尸；桥/App 主动断线重连。
 * 为什么不用 ws 协议层 ping：uni.connectSocket 的 JS 层收不到协议层帧（硬约束）。
 */
export interface PingMsg {
  kind: "ping";
  ts: number;
}

export interface PongMsg {
  kind: "pong";
  ts: number;
}

/** App 上报推送 token（M3 uni-push）：authed 后随时可发（拿到 cid 就发），中继 upsert 进 push_tokens 表 */
export interface PushTokenMsg {
  kind: "pushToken";
  token: string; // 个推 cid
  platform: string; // "ios" | "android"
}

export type ControlMsg =
  | HelloMsg
  | AuthChallengeMsg
  | AuthResponseMsg
  | AuthOkMsg
  | AuthErrorMsg
  | PingMsg
  | PongMsg
  | PushTokenMsg;

export function deviceIdFromKey(publicKeyB64: string): string {
  // 设备 id = 公钥哈希前 8 字节 hex，稳定且自证（任何人可重算）
  // 这里不 import tweetnacl 保持轻量：用公钥原文前 12 位即可，唯一性由注册表保证
  return `dev_${publicKeyB64.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`;
}
