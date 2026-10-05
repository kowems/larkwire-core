/**
 * 桥常驻核心（看+控）：发现转录会话 → 上报注册 → 实时增量推送（E2E 密文）→ 响应手机点播/发话。
 * 双皮一份逻辑（2026-09-23 WP1 可嵌入化）：CLI `larkwire watch/up` 与 Electron 桌面主进程
 * 都调 startBridge()——日志/致命/信号三条出口由 opts 决定（CLI=console+exit+信号处理；
 * desktop=sink+fatal 事件+宿主生命周期 stop()），行为口径两边逐字一致。
 */
import { EventEmitter } from "node:events";
import { format } from "node:util";
import {
  T,
  b64ToU8,
  type Envelope,
  type SessionRegisterBody,
  type SessionSubscribeBody,
  type StreamDeltaBody,
  type StreamSnapshotBody,
  type StreamAckBody,
  type PairRevokeBody,
  type PairStatusBody,
  type PairAcceptBody,
  type PresenceBody,
  type SessionUpdateBody,
  type InputSubmitBody,
  type InputAckBody,
  type PermissionRequestBody,
  type PermissionRespondBody,
  type PermissionResolveBody,
  type SessionTakeoverBody,
  type SessionTakeoverAckBody,
  type SessionOwnerBody,
  type SessionReleaseBody,
  type SessionReleaseAckBody,
  type NotifyRequestBody,
  type UiEvent,
} from "@larkwire/protocol";
import { loadConfig, saveConfig, configKeyPair, type PairedPeer } from "./config.js";
import { RelayConnection, type PeerKeys } from "./connection.js";
import { TranscriptWatcher, type WatchedSession } from "./watcher.js";
import { SessionController, type PermissionInfo } from "./controller.js";
import { TmuxAdapter } from "./tmux-adapter.js";
import { liveHolderPids, watchHolders, killHolder as registryKillHolder } from "./session-registry.js";
import { computeOccupancy, type Occupancy, type OccupancyCtx } from "./occupancy.js";
import { StateStore } from "./state.js";
import { readAlivePid, writePidfile, removeOwnPidfile } from "./pidfile.js";
import { getIdleSeconds } from "./idle.js";

function registerBody(s: WatchedSession): SessionRegisterBody {
  return {
    sessionId: s.sessionId,
    agent: s.agent,
    mode: "watch",
    project: s.project,
    title: s.title,
    cwd: s.cwd,
    startedAt: s.startedAt,
    lastActiveAt: s.lastActiveAt,
  };
}

/** startBridge 启动守卫拒启（未初始化/零配对/已有活桥在跑）——壳接住打印 message 即维持原文案 */
export class BridgeStartError extends Error {}

export interface BridgeOptions {
  projectsDir: string;
  relayOverride?: string;
  /** 被中继踢下（同身份第二个在线）时：true=process.exit(1)（CLI 契约）；false=发 handle "fatal" 事件由宿主决定（desktop） */
  exitOnFatal?: boolean;
  /** true=注册 SIGINT/SIGTERM 处理器（CLI 现状）；false=宿主生命周期里调 handle.stop()（desktop/Electron） */
  handleSignals?: boolean;
  /** 日志汇（每行已带 HH:MM:SS 前缀）：缺省 console.log（CLI 逐字现状）；desktop 传转发到窗口日志区 */
  onLog?: (line: string) => void;
}

/** snapshot 里的会话项=转录元数据 + 当前占用（WP5：桌面列表按 occupancy 出徽章/按钮） */
export type SnapshotSession = WatchedSession & { occupancy: Occupancy };

/** desktop 主窗状态条/会话列表的取数面（handle.on 事件提示何时重取） */
export interface BridgeSnapshot {
  deviceId: string;
  name: string;
  relay: string; // 生效值（--relay 覆盖后）
  connected: boolean; // 中继 auth.ok 态
  onlinePhones: number;
  pairedPhones: number;
  pendingPermissions: number; // 挂起等答复的权限卡
  sessions: SnapshotSession[];
}

export interface BridgeHandle {
  /** 干净停机（幂等）：杀子进程/停监听/关连接/清 pidfile，ws 合上后 resolve */
  stop(): Promise<void>;
  on(event: "log", cb: (line: string) => void): void;
  on(event: "fatal", cb: (info: { reason: string; message: string }) => void): void;
  on(event: "conn", cb: (connected: boolean) => void): void;
  on(event: "phones", cb: (onlineCount: number) => void): void;
  on(event: "sessions", cb: () => void): void; // 会话列表有变（注册/改名）→ 重取 snapshot()
  on(event: "revoked", cb: (deviceId: string) => void): void; // 手机侧发起撤销到达（本地发起的不经此事件）
  snapshot(): BridgeSnapshot;
  /** 桌面主动解绑一台手机：撤销通知发手机+中继，删本地配对；返回是否真有这台手机 */
  revokePeer(deviceId: string): boolean;
  /** 桌面本地发起的「还回」（WP5 #49）：温和释放+回执给持有手机，等同手机自己按还回；
   *  非 phone 态=纯幂等 no-op。返回是否走过受理链路（false=没有持有者可还） */
  releaseSession(sessionId: string): boolean;
  /** 桌面「关掉该窗口并接管」（WP5）：透传 session-registry.killHolder——四重验证 SIGTERM
   *  优雅杀，绝不自动 SIGKILL；terminal 共驾窗口同样靠它（条目 comm=claude） */
  killHolder(sessionId: string): { ok: boolean; pid?: number; reason?: string };
}

/**
 * 起桥常驻（看+控双模式）。同步完成本地装配+发起连接，返回句柄；
 * 启动守卫拒启抛 BridgeStartError（CLI 壳打印 message + exit 1，行为与旧 runWatch 逐字一致）。
 */
export function startBridge(opts: BridgeOptions): BridgeHandle {
  const exitOnFatal = opts.exitOnFatal ?? false;
  const handleSignals = opts.handleSignals ?? false;
  const loaded = loadConfig();
  if (!loaded) {
    throw new BridgeStartError("还没初始化身份。先运行：larkwire pair");
  }
  if (loaded.paired.length === 0) {
    throw new BridgeStartError("还没有配对的手机。先运行：larkwire pair");
  }
  const cfg = loaded; // 闭包内使用的非空引用
  // pidfile 互踢自守（第一刀 WP2）：install 后 LaunchAgent 常驻一个 watch——再手动起第二个
  // 会以同一桥身份连中继被 4000 互踢乒乓。正常启动 pidfile 必然不存在/陈尸（KeepAlive 复活
  // 撞车时旧进程已死，readAlivePid 返 null 放行）；活着的旧桥才拒启
  const aliveBridge = readAlivePid();
  if (aliveBridge !== null && aliveBridge !== process.pid) {
    throw new BridgeStartError(
      `✗ 桥已在运行（PID ${aliveBridge}）——同一台电脑只跑一个。\n  先停掉旧的：kill ${aliveBridge}（install 形态用 launchctl kickstart -k 重启），再重新运行。`,
    );
  }
  writePidfile();

  // 日志双出口：sink（CLI=console.log 逐字现状；desktop=转发窗口日志区）+ handle "log" 事件
  const emitter = new EventEmitter();
  const sink = opts.onLog ?? ((line: string) => console.log(line));
  function log(...args: unknown[]): void {
    const line = format(new Date().toISOString().slice(11, 19), ...args);
    sink(line);
    emitter.emit("log", line);
  }
  // --relay 只是本次临时覆盖：绝不写进 cfg（否则 handleRevoke 的 saveConfig 会把临时值静默持久化——2026-09-16 踩过）
  const relayUrl = opts.relayOverride ?? cfg.relay;
  if (opts.relayOverride && opts.relayOverride !== cfg.relay) {
    log(`⚠ 本次临时使用中继 ${relayUrl}（配置里的 ${cfg.relay} 未改动）`);
  }

  const keys = configKeyPair(cfg);
  const peers = new Map<string, PeerKeys & { name: string }>();
  for (const p of cfg.paired) {
    peers.set(p.deviceId, { deviceId: p.deviceId, publicKey: b64ToU8(p.publicKey), name: p.name });
  }

  const conn = new RelayConnection({
    relayUrl,
    deviceId: cfg.deviceId,
    publicKey: keys.publicKey,
    secretKey: keys.secretKey,
    name: cfg.name,
  });

  const state = new StateStore();
  const watcher = new TranscriptWatcher(opts.projectsDir, state);
  // tmux 适配器（WP4）：运行时软依赖，tmux 缺席 start() 返 false 降级关闭。
  // startBridge 同步契约不改——软探测+首轮扫描后台进行（tmux 轻量，5s 轮询内 appear 广播补齐）；
  // adapter 未就绪期间 ownerBody 漏 terminal，下一轮扫描/pane 变化的 appear 事件兜底。
  const tmuxAdapter = new TmuxAdapter({ log });
  void tmuxAdapter.start().then((enabled) => {
    if (enabled) log("tmux 共驾适配已启用（手机发话将直接注入关联终端）");
  });
  const controller = new SessionController(watcher, tmuxAdapter);
  const lastAck = new Map<string, number>(); // `${peer}:${session}` → seq（M0 内存态）
  const onlinePeers = new Set<string>(); // 中继重放在线对端（auth.ok 后）+ 上下线事件维护
  // clientMsgId 去重（App 重发同一条时回同样的 ack，不重复注入）：cap 200 条，先进先出
  const recentSubmits = new Map<string, InputAckBody>();
  // 「人离开才推完成通知」（Eric 拍板 2026-09-23）三个旋钮，默认=拍板值；验证时 env 调小加速
  const AWAY_IDLE_SEC = Number(process.env.LARKWIRE_AWAY_IDLE_SEC ?? 300);
  const DONE_DEBOUNCE_SEC = Number(process.env.LARKWIRE_DONE_DEBOUNCE_SEC ?? 60);
  const RUNEND_SUPPRESS_SEC = Number(process.env.LARKWIRE_RUNEND_SUPPRESS_SEC ?? 120);
  // 看模式完成检测：会话 → 防抖定时器；队列连跑时下一回合活动取消上一回合的定时器，
  // 天然只推最后一条 =「干完了」的正确语义
  const doneTimers = new Map<string, NodeJS.Timeout>();
  // 会话 → 最近一次控模式 runEnd 时刻：run 的转录也产 turnEnd，runEnd 已走自己的通知
  // 路径——抑制窗内看模式检测跳过（双发防护；run 占用期间宿主被闸门挡着，窗内撞真回合概率≈0）
  const lastRunEndAt = new Map<string, number>();
  // 手机持有登记（批次③ WP1 统一占用视图）：受理手机的话 = 这台手机持有该会话；回合跑完仍算
  // 持有（via=hold，直到还回 / 电脑端开窗翻 desktop）——release 受理与 releaseDone 两处清除
  const phoneHold = new Map<string, { to: string; since: number }>(); // sessionId → 持有手机
  // delta 升舱转录回显抑制集合（批次③ WP2，纯内容匹配，无时间相位）：
  // run 期间 token delta 已直播的 assistant 文本逐块记账（controller runBlockDone 推入）——
  // 转录回显到达时逐字匹配剔除，防「打字机 + 整段」双渲染。双向 fail-safe：
  // delta 漏投递 → 集合无此项 → 转录照发不失文本；已投递 → 抑制不重复。
  // until：run 期间 Infinity；runEnd/runFail 时收敛为 +10s grace——result 帧处理毫秒级而转录
  // 末行几乎总在 runs.delete 之后才被 500ms 轮询捞到（OUR_WRITE_MARGIN_MS 注释同款成因），
  // grace 覆盖这段落盘延迟；过期在 delta 投递点惰性清账
  const runSuppress = new Map<string, { until: number; texts: Set<string> }>(); // sessionId →
  const RUN_SUPPRESS_GRACE_MS = 10_000;

  // hint（M3）= 推送文案模板标签（"permission"/"runDone"）——notify 广播才带，
  // 中继路由时凭它选模板，无需解密 body（工具名/命令不出端）；
  // sid = 通知直达会话 id（明文可选）——中继塞进个推 payload，点通知直落该会话流页
  function broadcast(type: string, bodyOf: () => unknown, seq: number, hint?: string, sid?: string): void {
    for (const peer of peers.values()) {
      conn.sendSecure(peer, type as never, bodyOf(), seq, hint, sid);
    }
  }

  // 64KB 信封硬约束下的批量分片（密文≈base64 4/3+外壳）：一组 events 序列化后
  // 明文 ≤ 40KB；逐条贪心装组，装不下就开新组。单事件超限时不拆（adapter 已保证
  // 单事件 ≤32KB），独占一组照常发。offset 各组共用同一 endOffset——手机游标幂等推进。
  const DELTA_GROUP_BYTES = 40 * 1024;
  function partitionEvents<T>(events: T[]): T[][] {
    const groups: T[][] = [];
    let cur: T[] = [];
    let curBytes = 2; // []
    for (const ev of events) {
      const b = utf8JsonBytes(ev) + (cur.length ? 1 : 0);
      if (cur.length > 0 && curBytes + b > DELTA_GROUP_BYTES) {
        groups.push(cur);
        cur = [];
        curBytes = 2;
      }
      cur.push(ev);
      curBytes += b;
    }
    if (cur.length > 0) groups.push(cur);
    return groups;
  }

  function utf8JsonBytes(v: unknown): number {
    try {
      return new TextEncoder().encode(JSON.stringify(v)).length;
    } catch {
      return DELTA_GROUP_BYTES; // 序列化不出来的异常值按超限处理=独占一组，绝不阻塞后续
    }
  }

  // ---------- 控模式：controller 事件 → 中继 ----------

  const permissionBody = (info: PermissionInfo): PermissionRequestBody => ({
    sessionId: info.sessionId,
    requestId: info.requestId,
    tool: info.tool,
    description: info.description,
    inputSummary: info.inputSummary,
    inputJson: info.inputJson,
    suggestions: info.suggestions,
  });

  controller.on("permission", (info: PermissionInfo) => {
    if (onlinePeers.size === 0) {
      // Eric 拍板 2026-09-17：无手机在线【不代拒】——卡在授权等手机回来（上线时重投）。
      // M3 弹通知已落地：notify 广播 → 中继见手机离线转 uni-push（文案通用化，工具名不出端）
      controller.onAllPhonesOffline(); // 看门狗停摆
      broadcast(
        T.NotifyRequest,
        () => ({ level: "urgent", sessionId: info.sessionId, text: "🔐 灵鹊：有操作等你授权" }) satisfies NotifyRequestBody,
        0,
        "permission",
        info.sessionId,
      );
      log(`权限请示 ${info.tool} 但无手机在线 → 挂起等手机（已发推送）`);
      return;
    }
    broadcast(T.PermissionRequest, () => permissionBody(info), 0);
    log(`权限请示 ${info.tool}（${info.sessionId.slice(0, 8)}…）→ ${onlinePeers.size} 台手机在线`);
  });

  // 手机回来了：挂起的卡重投（App 按 requestId 去重，重复收不叠卡）
  controller.on("permissionReplay", (info: PermissionInfo) => {
    broadcast(T.PermissionRequest, () => permissionBody(info), 0);
    log(`挂起权限卡重投 ${info.tool}（${info.sessionId.slice(0, 8)}…）→ ${onlinePeers.size} 台手机在线`);
  });

  controller.on("permissionResolve", (r: PermissionResolveBody) => {
    broadcast(T.PermissionResolve, () => r, 0);
    log(`权限了结 ${r.requestId.slice(0, 8)}… outcome=${r.outcome}`);
  });

  // token 级增量直播（批次③ WP2 delta 升舱）：run 期间 assistant 文本直达手机（打字机）。
  // ⚠️ offset 填 watcher 当前偏移【不推进】——seq 域=转录字节偏移，手机 StreamAck 驱动断线
  // 续传 readFrom(offset)；delta 是纯瞬时加速面，唯一持久事实源仍是转录（ack 绝不能凭它
  // 跳过未投递字节）。空 text + turnEnd=result 时桥合成的收工帧（清手机忙碌指示器）
  controller.on("runDelta", (dd: { sessionId: string; text: string; turnEnd?: boolean }) => {
    const offset = watcher.getSession(dd.sessionId)?.offset ?? 0;
    const ev: UiEvent = {
      kind: "assistant",
      ts: Date.now(),
      text: dd.text,
      delta: true,
      ...(dd.turnEnd ? { turnEnd: true } : {}),
    };
    broadcast(T.StreamDelta, () => ({ sessionId: dd.sessionId, events: [ev], offset }) satisfies StreamDeltaBody, offset);
  });

  // 整块直播完 → 记进抑制集合（run 期间到达的转录回显也要能匹配，不能等 runEnd 才建账）
  controller.on("runBlockDone", (b: { sessionId: string; text: string }) => {
    const entry = runSuppress.get(b.sessionId) ?? { until: Number.POSITIVE_INFINITY, texts: new Set<string>() };
    entry.texts.add(b.text);
    entry.until = Number.POSITIVE_INFINITY; // run 在飞期间不过期
    runSuppress.set(b.sessionId, entry);
  });

  // 受理后跑挂的迟到回执（起进程失败/看门狗/进程早退）：复用 input.ack ok=false，App toast
  controller.on("runFail", (f: { sessionId: string; clientMsgId: string; reason: string }) => {
    // delta 升舱：失败 run 也有已直播的块（转录最后一次 flush 还会把它们带回来）——
    // 抑制集合收敛为 grace 窗，防 Infinity 陈尸永久误抑制
    const sup = runSuppress.get(f.sessionId);
    if (sup) sup.until = Date.now() + RUN_SUPPRESS_GRACE_MS;
    // phase:"runFail" 标记「回合已死」——App 凭它停忙碌指示器（区别于即时拒收：别的 run 可能还在跑）
    const ack: InputAckBody = { sessionId: f.sessionId, clientMsgId: f.clientMsgId, ok: false, reason: f.reason, phase: "runFail" };
    // M1.5：空跑兜底本就是「占用闸门漏网形态」的兜底——复查注册表，仍被占用的带上 PID，
    // App 才能在这条失败路径上也亮出「抢夺控制权」（run 已结束，runs 锁已释放，复查安全）
    // 从全部活持有者里选第一个外部 PID（影子与外部 IDE 并存时不被文件序遮住）
    const holder = liveHolderPids(f.sessionId).find((p) => !controller.isOurChild(p)) ?? null;
    // 看门狗路径 emit runFail 时子进程可能还活着（endRun 在 emit 后才杀），但它是桥自己孩子，
    // 上面已排除——只在确有外部占用时带 PID，App 才在这条失败路径亮「抢夺控制权」
    if (holder !== null) ack.occupiedPid = holder;
    broadcast(T.InputAck, () => ack, 0);
    log(`run 失败 ${f.sessionId.slice(0, 8)}…：${f.reason}`);
  });

  controller.on("runEnd", (e: { sessionId: string; why: string }) => {
    log(`run 结束 ${e.sessionId.slice(0, 8)}…（${e.why}）`);
    lastRunEndAt.set(e.sessionId, Date.now()); // 看模式完成检测的双发抑制窗
    // delta 升舱：抑制集合收敛为 grace 窗——result 后转录最后一次 flush 仍按集合匹配抑制，
    // 窗过即惰性清账（集合里的块此后若再现=新回合碰巧同文，照发不误伤）
    const sup = runSuppress.get(e.sessionId);
    if (sup) sup.until = Date.now() + RUN_SUPPRESS_GRACE_MS;
    // M3 推送（D8「会话完成」= 控模式回合结束，正常/异常统一 runDone 模板）：
    // 手机全不在线才发——在线手机不发不打扰，中继侧还会再查一次 presence（最权威）
    //
    // ⚠️ 修订拍板 2026-09-23（supersede 同日早些时候「人离开闸门套全部完成通知」）：
    // runEnd【不】套键鼠空闲闸门（Eric 原话：手机上发的，跟电脑鼠标动不动没关系，
    // 会话完成都应该推手机通知）。理由：run 是手机发起的——发起动作本身证明人在手机侧，
    // 且 run 的结果电脑上没有任何窗口可见（桌面 UI 未做），「人在电脑前」不等于「他知道
    // run 完了」。闸门只管看模式 turnEnd（电脑自己的 CC，输出就在电脑屏幕上）。
    // 权限卡同样不套闸门（卡是阻塞型应答且电脑上无答卡 UI，不推=死等）。
    if (onlinePeers.size === 0) {
      broadcast(
        T.NotifyRequest,
        () => ({ level: "done", sessionId: e.sessionId, text: "✅ 灵鹊：会话回合完成" }) satisfies NotifyRequestBody,
        0,
        "runDone",
        e.sessionId,
      );
    }
  });

  // 温和还回的第二段回执（Eric 拍板 2026-09-20）：回合自然说完 = 进程退场 = 控制权天然回电脑。
  // 此时转录已完整落盘——手机收到它时 Mac 上 resume 必能看到完整回合
  controller.on("releaseDone", (d: { sessionId: string; to: string; requestId: string; why: string }) => {
    // 还回完成 = phoneHold 清除 + 全量广播重算（批次③ WP1）——必须放在预约手机在册检查之前：
    // 手机已不在册也要清登记、广播翻掉📱横幅，别成陈尸
    phoneHold.delete(d.sessionId);
    invalidateOccupancy(d.sessionId);
    broadcast(T.SessionOwner, () => ownerBody(d.sessionId), 0);
    const to = peers.get(d.to);
    if (!to) {
      log(`还回完成 ${d.sessionId.slice(0, 8)}…（${d.why}）但预约手机 ${d.to} 已不在册，回执不发`);
      return;
    }
    const ack: SessionReleaseAckBody = {
      sessionId: d.sessionId,
      requestId: d.requestId,
      ok: true,
      reason: "会话已还回电脑——回合已结束。电脑上重新打开（resume）这个会话接着干：旧窗口不知道手机回合的存在，在里面直接打字会造成上下文分叉",
    };
    conn.sendSecure(to, T.SessionReleaseAck, ack, 0);
    log(`还回完成 ${d.sessionId.slice(0, 8)}…（${d.why}）→ 最终回执已发`);
  });

  // Runner 闲置回收（批次③ WP3，LARKWIRE_RUNNER_IDLE_MS 默认 10min 无新回合触发）：
  // 进程已温和退场 = 手机不再持有——清 phoneHold + 广播 owner 重算翻掉📱横幅，
  // 并向最近受理手机发合成 SessionReleaseAck（requestId 合成 lw-idle-*，App 按未知
  // requestId 忽略是安全的——owner 广播才是翻 UI 的实际驱动，ack 属定向告知）
  controller.on("runnerIdle", (d: { sessionId: string; holderTo?: string }) => {
    phoneHold.delete(d.sessionId);
    invalidateOccupancy(d.sessionId);
    broadcast(T.SessionOwner, () => ownerBody(d.sessionId), 0);
    log(`影子进程闲置回收 ${d.sessionId.slice(0, 8)}…`);
    if (!d.holderTo) return;
    const to = peers.get(d.holderTo);
    if (!to) return;
    const ack: SessionReleaseAckBody = {
      sessionId: d.sessionId,
      requestId: `lw-idle-${Date.now()}`,
      ok: true,
      reason: "影子进程闲置超时已回收——手机侧持有已解除。再从手机发话会重新拉起（断点续跑不丢上下文）",
    };
    conn.sendSecure(to, T.SessionReleaseAck, ack, 0);
  });

  function rememberSubmit(clientMsgId: string, ack: InputAckBody): void {
    // 只缓存受理 ack：拒收没产生任何动作，缓存只会挡死合法重试——
    // 真机实证 2026-09-19：占用拒收入缓存 → 抢夺成功后重发同 msgId 被回旧拒收，死循环
    if (!ack.ok) return;
    if (recentSubmits.size >= 200) {
      const oldest = recentSubmits.keys().next().value;
      if (oldest !== undefined) recentSubmits.delete(oldest);
    }
    recentSubmits.set(clientMsgId, ack);
  }

  // ---------- 控制权归属（A+B，Eric 拍板 2026-09-19） ----------

  /** 统一占用取数面（批次③ WP1+WP4）。
   *  holders 给全部活持有者——occupancy 自己用 isOurChild 跳过桥孩子，否则手机回合被误判
   *  成「电脑端接管」、外部 IDE 也会被文件序在前的影子遮住（用例④真机钓出） */
  const occupancyCtx: OccupancyCtx = {
    hasRun: (sid) => controller.hasRun(sid),
    phoneHold,
    holders: liveHolderPids,
    isOurChild: (pid) => controller.isOurChild(pid),
    // tmux 活会话投影：adapter 未就绪/无关联时 undefined=不判 terminal
    tmuxAssoc: (sid) => {
      const a = tmuxAdapter.associationFor(sid);
      return a ? { claudePid: a.claudePid } : undefined;
    },
  };

  /**
   * occupancy 短 TTL 缓存（WP5）：snapshot() 一次给全部会话算占用，桌面列表刷新频率高
   * （每次 sessions/conn/phones 事件都重取），而 occupiedBy 内部有同步 ps 调用——
   * 1s 内重放同一结果，状态变化最坏滞后 1s 到 UI，可接受（owner 帧广播本身不受缓存影响）
   */
  const occCache = new Map<string, { at: number; occ: Occupancy }>();
  const OCC_CACHE_MS = 1_000;

  function occupancyOf(sessionId: string): Occupancy {
    const now = Date.now();
    const hit = occCache.get(sessionId);
    if (hit && now - hit.at < OCC_CACHE_MS) return hit.occ;
    const occ = computeOccupancy(sessionId, occupancyCtx);
    occCache.set(sessionId, { at: now, occ });
    return occ;
  }

  /**
   * 占用事实刚变（受理/还回/抢夺/holder 增减/tmux 增减）：废缓存——下一次取数立即重算，
   * 不等 TTL；并 emit「sessions」通知桌面 pushState。
   * 2026-09-26 用例⑦真机钓出：原先只废缓存 + 广播 owner 给手机，桌面订阅的是 bridge.on("sessions")，
   * 没有任何占用切换点 emit 它 → 徽章冻在首帧（手机已正确翻态、桌面纹丝不动）。
   * 全部调用点都是占用真正变化、桌面必须刷新的点（无一处是「只想废缓存」），故事实下沉到这里统一发。
   */
  function invalidateOccupancy(sessionId: string): void {
    occCache.delete(sessionId);
    emitter.emit("sessions");
  }

  /** 会话当前持有者状态（批次③ WP1 四态：desktop/terminal/phone/none）——判定链只有 occupancy.ts 一份 */
  function ownerBody(sessionId: string): SessionOwnerBody {
    const occ = occupancyOf(sessionId);
    switch (occ.state) {
      case "desktop":
        return { sessionId, owner: "desktop", pid: occ.pid };
      case "terminal":
        return { sessionId, owner: "terminal", pid: occ.pid };
      case "phone":
        return { sessionId, owner: "phone" };
      default:
        return { sessionId, owner: "none" };
    }
  }

  /**
   * 「还回」共用链路（WP5 抽出）：relay 上的手机帧与桌面本地发起同体——
   * controller.release 温和释放 → ack 定向发给 to（=持有手机；已不在册则只记日志）→
   * phoneHold 清除 → 非预约立即广播 owner 重算。scheduled（回合还在跑）不广播，等 releaseDone 第二段。
   * 返回受理结果，供调用方写自己的 ack/日志（relay 路径的 ack 已在本函数内发出）
   */
  function handleRelease(
    sessionId: string,
    to: string,
    requestId: string,
  ): { ok: boolean; reason?: string; interruptedRun?: boolean; scheduled?: boolean } {
    const result = controller.release(sessionId, to, requestId);
    const peer = peers.get(to);
    if (peer) {
      const ack: SessionReleaseAckBody = {
        sessionId,
        requestId,
        ok: result.ok,
        reason: result.reason,
        interruptedRun: result.interruptedRun,
        scheduled: result.scheduled,
      };
      conn.sendSecure(peer, T.SessionReleaseAck, ack, 0);
    } else {
      log(`还回目标 ${to} 已不在册，回执不发（${sessionId.slice(0, 8)}…）`);
    }
    if (result.ok) {
      phoneHold.delete(sessionId);
      invalidateOccupancy(sessionId);
      if (!result.scheduled) broadcast(T.SessionOwner, () => ownerBody(sessionId), 0);
    }
    log(
      result.scheduled
        ? `还回预约 ${sessionId.slice(0, 8)}…：回合还在跑，说完自动交接`
        : `还回电脑 ${sessionId.slice(0, 8)}…：本就闲着（幂等 ok）`,
    );
    return result;
  }

  // 方案 B「坐下即用」：回电脑开窗 → 注册表多一条活条目 → 有手机 run 杀 run 让位 + 推 owner。
  // 关窗 → 确实没人持有了才推 owner=none（多持有者场景防误清）
  const stopHolderWatch = watchHolders(
    (h) => {
      if (controller.isOurChild(h.pid)) return; // 自己 spawn 的 run 子进程不算电脑端接管
      if (h.kind !== undefined && h.kind !== "interactive") return; // 非交互进程不构成「人坐下了」
      const runBusy = controller.onDesktopHolderAppeared(h.sessionId, h.pid);
      invalidateOccupancy(h.sessionId);
      const body: SessionOwnerBody = {
        sessionId: h.sessionId,
        owner: "desktop",
        pid: h.pid,
        // 温和交接（Eric 拍板 2026-09-20）：手机回合不杀——它说完自然退场，控制权完整归电脑
        ...(runBusy ? { note: "电脑端已开窗——手机上的回合会让它说完，之后会话完整归电脑" } : {}),
      };
      broadcast(T.SessionOwner, () => body, 0);
      log(`电脑端开窗 ${h.sessionId.slice(0, 8)}…（PID ${h.pid}）→ 推 owner=desktop${runBusy ? "，手机回合继续说完" : ""}`);
    },
    (h) => {
      if (controller.isOurChild(h.pid)) return;
      invalidateOccupancy(h.sessionId);
      // 重算：还有 desktop 持有者（同会话开俩窗）就不动；否则广播重算结果——批次③ WP1 四态后
      // 手机持有（phoneHold）也要翻回去，不然手机横幅停在 desktop 成陈尸（对计划「广播路径不变」
      // 字面的必要偏离：旧条件 !=="none" 会在 phone 重算时 return，漏广播）
      const body = ownerBody(h.sessionId);
      if (body.owner === "desktop") return;
      broadcast(T.SessionOwner, () => body, 0);
      log(`电脑端关窗 ${h.sessionId.slice(0, 8)}…（PID ${h.pid}）→ 推 owner=${body.owner}`);
    },
  );

  // tmux pane 关联出现/消失（WP4）：广播 ownerBody 重算结果——不写死 terminal，
  // run 在飞时优先级链仍判 phone（手机回合跑着，tmux 开窗不抢横幅）；
  // adapter 首轮扫描可能早于中继 auth（sendSecure 跳过），subscribe 时 ownerBody 补发 +
  // 后续 5s 轮询内容变化时再次 appear 兜底
  tmuxAdapter.on("appear", (t: { sessionId: string; claudePid: number }) => {
    invalidateOccupancy(t.sessionId);
    broadcast(T.SessionOwner, () => ownerBody(t.sessionId), 0);
    log(`tmux 会话出现 ${t.sessionId.slice(0, 8)}…（claude PID ${t.claudePid}）→ 推 owner=${ownerBody(t.sessionId).owner}`);
  });
  tmuxAdapter.on("disappear", (d: { sessionId: string }) => {
    invalidateOccupancy(d.sessionId);
    broadcast(T.SessionOwner, () => ownerBody(d.sessionId), 0);
    log(`tmux 会话消失 ${d.sessionId.slice(0, 8)}… → 推 owner=${ownerBody(d.sessionId).owner}`);
  });

  watcher.on("register", (s: WatchedSession) => {
    log(`会话注册 ${s.sessionId.slice(0, 8)}…（${s.project}）→ ${peers.size} 台手机`);
    broadcast(T.SessionRegister, () => registerBody(s), 0);
    emitter.emit("sessions");
  });

  watcher.on("update", (s: WatchedSession, title: string) => {
    broadcast(T.SessionUpdate, () => ({ sessionId: s.sessionId, title } satisfies SessionUpdateBody), 0);
    emitter.emit("sessions");
  });

  // ---------- 看模式完成检测（Eric 拍板 2026-09-23：人离开才推完成通知） ----------
  // 适配器已把「回合终点」翻译成 turnEnd 标记（assistant 行 stop_reason 非 tool_use 且含
  // text block）——这里只扫布尔字段，零新解析。防抖：end_turn 后 CC 又在干活/真人发话
  // 就取消待发；title/system/raw 是回合末元记录，不动定时器。

  function clearDoneTimer(sessionId: string): void {
    const t = doneTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      doneTimers.delete(sessionId);
    }
  }

  // 到点判定（防抖计时器 firing）：getIdleSeconds 已异步化（WP1——execSync 最长 5s 同步阻塞
  // 在 Electron 主进程会卡 IPC/托盘），判定逻辑抽成 async 函数，三条件全在【当前刻】判定
  async function fireDoneNotify(sessionId: string): Promise<void> {
    doneTimers.delete(sessionId);
    // 防抖期内手机上下线、人来回都可能已发生——全在当前刻现查
    if (onlinePeers.size > 0) return; // 手机在线=正在看，不打扰（runEnd 同款）
    const lastRun = lastRunEndAt.get(sessionId);
    if (lastRun !== undefined && Date.now() - lastRun < RUNEND_SUPPRESS_SEC * 1000) {
      log(`看模式完成通知抑制 ${sessionId.slice(0, 8)}…：${Math.round((Date.now() - lastRun) / 1000)}s 前 runEnd 已通知（双发防护）`);
      return;
    }
    const idleSec = await getIdleSeconds();
    if (idleSec < AWAY_IDLE_SEC) {
      log(`看模式完成通知抑制 ${sessionId.slice(0, 8)}…：人在电脑前（键鼠 ${Math.round(idleSec)}s 前有活动）`);
      return;
    }
    broadcast(
      T.NotifyRequest,
      () => ({ level: "done", sessionId, text: "✅ 灵鹊：会话回合完成" }) satisfies NotifyRequestBody,
      0,
      "runDone",
      sessionId,
    );
    log(`人离开（键鼠空闲 ${Math.round(idleSec / 60)} 分钟）+ 回合完成 ${sessionId.slice(0, 8)}… → 已发推送`);
  }

  function scheduleDoneNotify(sessionId: string): void {
    clearDoneTimer(sessionId); // 连发 end_turn（重排）以最后一条为准
    doneTimers.set(
      sessionId,
      setTimeout(() => {
        void fireDoneNotify(sessionId);
      }, DONE_DEBOUNCE_SEC * 1000),
    );
  }

  watcher.on("delta", (d: { session: WatchedSession; events: unknown[]; endOffset: number }) => {
    const sid = d.session.sessionId;
    // delta 升舱转录回显抑制（批次③ WP2，纯内容匹配）：本批里「token delta 已逐字直播过」的
    // assistant 事件剔除，防打字机+整段双渲染。fail-safe：文本不在集合=没直播过=照发不丢。
    // 只作用于这个直播投递点——serveSnapshot 的 readFrom/readSnapshot 重放路径不抑制
    // （离线手机重连照样收全文本）。抑制后全空也照广播 events:[]+真实 endOffset：
    // 手机游标照常推进，重连不会把这些字节重放回来（内容已经 delta 过了）
    let events = d.events;
    const sup = runSuppress.get(sid);
    if (sup !== undefined) {
      if (!controller.hasRun(sid) && Date.now() >= sup.until) {
        runSuppress.delete(sid); // grace 过期清账
      } else {
        events = (d.events as Array<{ kind?: string; text?: string }>).filter(
          (ev) => !(ev.kind === "assistant" && typeof ev.text === "string" && sup.texts.has(ev.text)),
        );
      }
    }
    // 批量分片：一条 assistant 行内多个 tool_use 同批到达，单帧不能吃光 64KB 信封。
    // 空批照发（events:[]+真实 endOffset，游标推进+抑制语义）；非空批逐组广播，offset 共用
    const groups = events.length === 0 ? [events] : partitionEvents(events);
    for (const g of groups) {
      broadcast(T.StreamDelta, () => ({ sessionId: sid, events: g as never, offset: d.endOffset }) satisfies StreamDeltaBody, d.endOffset);
    }
    const suppressed = d.events.length - events.length;
    log(`增量 ${sid.slice(0, 8)}… +${events.length} 事件 @${d.endOffset}${suppressed > 0 ? `（抑制转录回显 ${suppressed} 条）` : ""}`);
    // 看模式完成检测【用过滤前原数组】：turnEnd 被抑制 ≠ 回合没完——这里的检测只看转录事实，
    // 与投递面无关（手机侧 busy 由 runDelta 通道的合成 turnEnd 收场）
    // events 保序（translateChunk 按行序产出）——逐事件顺序处理，
    // 后发生的覆盖先发生的：turnEnd 后又来活动=取消（没「完」），活动后 turnEnd=重排
    for (const e of d.events) {
      const ev = e as { kind?: string; turnEnd?: boolean };
      if (ev.kind === "assistant" && ev.turnEnd === true) {
        scheduleDoneNotify(sid);
      } else if (
        ev.kind === "user" ||
        ev.kind === "assistant" ||
        ev.kind === "thinking" ||
        ev.kind === "tool_use" ||
        ev.kind === "tool_result"
      ) {
        clearDoneTimer(sid);
      }
    }
  });

  // async：input.submit 处理器要 await controller.submit（WP4 tmux 注入为异步操作）。
  // EventEmitter 不 await 返回的 Promise——各分支自行 try/catch，异常不外泄成 unhandledRejection
  conn.on("envelope", async (env: Envelope) => {
    // 中继代发的在场/解绑通知（明文 body）
    if (env.from === "relay") {
      if (env.type === T.PresenceOnline || env.type === T.PresenceOffline) {
        try {
          const p = JSON.parse(env.body) as PresenceBody;
          if (p.online) {
            const wasEmpty = onlinePeers.size === 0;
            onlinePeers.add(p.deviceId);
            emitter.emit("phones", onlinePeers.size);
            // 上线时序补救（2026-09-20 空列表事故）：手机先上线、桥后上线时，App 的
            // SessionList 请求已撞桥离线窗口被丢弃，且 App 只有 ready 时才拉——这里
            // 主动推全量注册做双保险（App 按 sessionId 去重，幂等）
            const peer = peers.get(p.deviceId);
            if (peer) {
              const all = watcher.listSessions();
              for (const s of all) {
                conn.sendSecure(peer, T.SessionRegister, registerBody(s), 0);
              }
              log(`手机上线补推会话注册 ${all.length} 个 → ${p.deviceId.slice(0, 10)}…`);
            }
            if (wasEmpty) {
              const parked = controller.pendingCount();
              controller.onPhoneOnline(); // 重投挂起的卡（permissionReplay）+ 时钟重新给满
              if (parked > 0) log(`手机回来：重投 ${parked} 张挂起权限卡`);
            }
          } else {
            onlinePeers.delete(p.deviceId);
            emitter.emit("phones", onlinePeers.size);
            if (onlinePeers.size === 0) {
              controller.onAllPhonesOffline(); // 拍板 2026-09-17：不代拒，卡挂起，时钟停摆
              log("手机全离线：权限卡挂起等手机回来（时钟停摆）");
            }
          }
          log(p.online ? `手机上线 ${p.deviceId}` : `手机下线 ${p.deviceId}`);
        } catch { /* ignore */ }
      } else if (env.type === T.PairRevoke) {
        handleRevoke(env);
      } else if (env.type === T.PairStatus) {
        handlePairStatus(env);
      }
      return;
    }

    // 手机扫的是已退出 pair 进程留下的二维码（offer 还挂在中继、被路由到 watch）——
    // 明确回绝，别让 App 在"等待指纹确认"上干等
    if (env.type === T.PairAccept) {
      try {
        const body = JSON.parse(env.body) as PairAcceptBody;
        conn.sendPlain(env.from, T.PairError, {
          token: body.token,
          stage: "accept",
          reason: "这个二维码的配对进程已退出（pair 和 watch 不能同时跑）。请在电脑上重新运行 pnpm pair，扫新二维码。",
        });
        log(`回绝过期配对 token=${body.token}（pair 进程已退出，accept 路由到了 watch）`);
      } catch { /* ignore */ }
      return;
    }

    const peer = peers.get(env.from);
    if (!peer) return; // 中继已挡未配对设备，这里双保险

    if (env.type === T.SessionList) {
      // App 刷新/重连后拉全量列表（register 是纯推送，对方不在线或页面重开就丢了）——
      // 对这台手机重发全部已知会话的注册（App 侧按 sessionId 去重，幂等）
      try {
        conn.decryptFrom(peer, env); // 统一验证密文来源，body 为空对象
      } catch {
        log(`无法解密的 session.list from ${env.from}，丢弃`);
        return;
      }
      const all = watcher.listSessions();
      for (const s of all) {
        conn.sendSecure(peer, T.SessionRegister, registerBody(s), 0);
      }
      log(`会话列表重同步 ${all.length} 个 → ${peer.deviceId.slice(0, 10)}…`);
      return;
    }

    if (env.type === T.PermissionList) {
      // M3 缝隙补漏（D3）：iOS 后台 ≤90s 回前台时 presence 无 offline→online 转换、
      // permissionReplay 不触发，直路由丢的卡靠拉取兜底——对这台手机重发全部挂起卡
      // （App 按 requestId 去重，幂等）
      try {
        conn.decryptFrom(peer, env); // 统一验证密文来源，body 为空对象
      } catch {
        log(`无法解密的 permission.list from ${env.from}，丢弃`);
        return;
      }
      const parked = controller.pendingList();
      for (const info of parked) {
        conn.sendSecure(peer, T.PermissionRequest, permissionBody(info), 0);
      }
      if (parked.length > 0) log(`挂起权限卡拉取重投 ${parked.length} 张 → ${peer.deviceId.slice(0, 10)}…`);
      return;
    }

    if (env.type === T.SessionSubscribe) {
      let sub: SessionSubscribeBody;
      try {
        sub = conn.decryptFrom(peer, env) as SessionSubscribeBody;
      } catch {
        log(`无法解密的 subscribe from ${env.from}，丢弃`);
        return;
      }
      serveSnapshot(peer, sub);
      // 推当前持有者状态（A+B）：订阅=打开会话页，App 状态条需要立刻有依据（不等下一次变化推送）
      conn.sendSecure(peer, T.SessionOwner, ownerBody(sub.sessionId), 0);
      // delta 升舱中途订阅补发（批次③ WP2）：run 在飞时 snapshot（转录）里还没有正在打的这段
      // 字——补发一条合成 partial delta 开新泡，后续 token delta 自然并入（App 按 delta 拼接）。
      // 已知局限：跨 text block 的工具卡顺序在平铺累计里丢失，仅影响中途订阅者的当前泡
      const rs = controller.runSnapshot(sub.sessionId);
      if (rs !== null && rs.partialText !== "") {
        const offset = watcher.getSession(sub.sessionId)?.offset ?? 0;
        const ev: UiEvent = { kind: "assistant", ts: Date.now(), text: rs.partialText, delta: true };
        conn.sendSecure(peer, T.StreamDelta, { sessionId: sub.sessionId, events: [ev], offset } satisfies StreamDeltaBody, offset);
        log(`中途订阅补发 partial delta ${sub.sessionId.slice(0, 8)}… len=${rs.partialText.length} → ${peer.deviceId.slice(0, 10)}…`);
      }
      return;
    }

    if (env.type === T.StreamAck) {
      try {
        const ack = conn.decryptFrom(peer, env) as StreamAckBody;
        lastAck.set(`${env.from}:${ack.sessionId}`, ack.lastSeq);
      } catch { /* ignore */ }
      return;
    }

    // ---------- 控模式（M1） ----------

    if (env.type === T.InputSubmit) {
      let body: InputSubmitBody;
      try {
        body = conn.decryptFrom(peer, env) as InputSubmitBody;
      } catch {
        log(`无法解密的 input.submit from ${env.from}，丢弃`);
        return;
      }
      // 重发去重：受理 ack 丢了 App 会重试，同 clientMsgId 直接回上次的受理结果（拒收不入缓存，不挡重试）
      const dup = recentSubmits.get(body.clientMsgId);
      if (dup) {
        conn.sendSecure(peer, T.InputAck, dup, 0);
        log(`input.submit 重发去重 ${body.clientMsgId.slice(0, 8)}… → 回上次受理 ack`);
        return;
      }
      const result = await controller.submit(body.sessionId, body.text, body.clientMsgId, env.from);
      const ack: InputAckBody = {
        sessionId: body.sessionId,
        clientMsgId: body.clientMsgId,
        ok: result.ok,
        reason: result.reason,
        occupiedPid: result.occupiedPid, // 占用类拒收带 PID，App 凭此亮「抢夺控制权」（非占用类为 undefined，JSON 序列化自动省略）
        via: result.via, // tmux=注入终端共驾；resume/省略=影子进程
      };
      rememberSubmit(body.clientMsgId, ack);
      conn.sendSecure(peer, T.InputAck, ack, 0);
      // 受理 = 这台手机持有该会话（批次③ WP1 四态占用）：登记 phoneHold + 广播 owner:phone。
      // （旧行为推 owner=none「对账」——四态模型下受理即持有，none 是谎言；run 在飞时
      // computeOccupancy 第一优先级本就判 phone(via=run)，广播与后续重算一致）
      // ⚠️ via==="tmux" 共驾路径例外：话注入了终端活会话，持有者【仍是终端】——
      // 不登记 phoneHold、不推 owner:phone（否则横幅谎称📱，回合结束也无还回可言）。
      // 回合数据面走既有转录回显，assistant 应答照滚上手机
      if (result.ok && result.via !== "tmux") {
        phoneHold.set(body.sessionId, { to: env.from, since: Date.now() });
        invalidateOccupancy(body.sessionId);
        broadcast(T.SessionOwner, () => ({ sessionId: body.sessionId, owner: "phone" } satisfies SessionOwnerBody), 0);
      }
      log(
        result.ok
          ? `受理发话 ${body.sessionId.slice(0, 8)}…「${body.text.slice(0, 30)}」${result.via === "tmux" ? "（注入终端共驾）" : ""}`
          : `拒收发话 ${body.sessionId.slice(0, 8)}…：${result.reason}`,
      );
      return;
    }

    if (env.type === T.PermissionRespond) {
      let body: PermissionRespondBody;
      try {
        body = conn.decryptFrom(peer, env) as PermissionRespondBody;
      } catch {
        log(`无法解密的 permission.respond from ${env.from}，丢弃`);
        return;
      }
      const handled = controller.respond(body.requestId, body.behavior, body.message);
      // 答完广播撤卡：其他手机上的同一张卡也要撤（答了的那台本地乐观撤卡，收到这条幂等）
      const resolve: PermissionResolveBody = handled
        ? { sessionId: body.sessionId, requestId: body.requestId, outcome: "answered" }
        : { sessionId: body.sessionId, requestId: body.requestId, outcome: "cancelled", note: "请求已了结（其他手机已答复或回合结束）" };
      broadcast(T.PermissionResolve, () => resolve, 0);
      log(`权限答复 ${body.requestId.slice(0, 8)}… ${body.behavior}${handled ? "" : "（迟到，请求已了结）"}`);
      return;
    }

    if (env.type === T.SessionTakeover) {
      // 手机「抢夺控制权」（M1.5）：杀电脑端持有者进程 → 占用闸门打开 → App 自动重发。
      // 幂等天然防重（重复帧/多手机同按：后到者 occupiedBy=null → ok），无需去重缓存
      let body: SessionTakeoverBody;
      try {
        body = conn.decryptFrom(peer, env) as SessionTakeoverBody;
      } catch {
        log(`无法解密的 session.takeover from ${env.from}，丢弃`);
        return;
      }
      const result = controller.takeover(body.sessionId);
      const ack: SessionTakeoverAckBody = {
        sessionId: body.sessionId,
        requestId: body.requestId,
        ok: result.ok,
        reason: result.reason,
        killedPid: result.killedPid,
      };
      conn.sendSecure(peer, T.SessionTakeoverAck, ack, 0);
      // 抢夺成功 = 占用闸门已开 → 推 owner=none 对账（横幅消掉，App 可以发话了）
      if (result.ok) {
        invalidateOccupancy(body.sessionId);
        broadcast(T.SessionOwner, () => ({ sessionId: body.sessionId, owner: "none" } satisfies SessionOwnerBody), 0);
      }
      log(
        result.ok
          ? `抢夺控制权 ${body.sessionId.slice(0, 8)}… 成功${result.killedPid !== undefined ? `（已关掉电脑端进程 PID ${result.killedPid}）` : "（本就没人占用）"}`
          : `抢夺控制权 ${body.sessionId.slice(0, 8)}… 失败：${result.reason}`,
      );
      return;
    }

    if (env.type === T.SessionRelease) {
      // 手机「还回电脑」（方案 A，2026-09-20 温和还回）：run 在跑=预约不杀，回合说完自动交接
      // （第二段回执走 controller 的 releaseDone）。幂等天然防重：没在跑 → ok interruptedRun=false
      let body: SessionReleaseBody;
      try {
        body = conn.decryptFrom(peer, env) as SessionReleaseBody;
      } catch {
        log(`无法解密的 session.release from ${env.from}，丢弃`);
        return;
      }
      // 共用链路（WP5 抽出 handleRelease）：温和释放 + ack 给本手机 + phoneHold 清除 + 广播
      handleRelease(body.sessionId, env.from, body.requestId);
      return;
    }

    if (env.type === T.PairRevoke) {
      handleRevoke(env);
      return;
    }

    // 已知设备的未匹配类型（新旧版本混跑时新帧落到这）——留线索再丢，别沉默
    log(`未识别的帧类型 ${env.type} from ${env.from.slice(0, 10)}…，丢弃（对端版本更新？）`);
  });

  function handleRevoke(env: Envelope): void {
    try {
      const body = JSON.parse(env.body) as PairRevokeBody;
      log(`✂ 收到 PairRevoke（from=${env.from}）目标=${body.targetDeviceId}`);
      if (removePeer(body.targetDeviceId, "incoming")) {
        log(`设备已解绑：${body.targetDeviceId}（剩余 ${peers.size} 台手机）`);
      } else {
        log(`⚠ PairRevoke 目标 ${body.targetDeviceId} 不在本地配对列表，仅记录不处理`);
      }
    } catch (err) {
      log(`⚠ PairRevoke 解析失败：${String(err)}`);
    }
  }

  /** #83 连接时对账：中继下发全部 active 对端，本地有、列表里没有的一律清掉。
   *  覆盖离线队列 TTL（10 分钟）之外的撤销，与离线时长无关；只清理不回发（reason=incoming）。
   *  若这封来自重连后的连接，入站排队的撤销帧可能已经先处理过——removePeer 幂等，重复无害 */
  function handlePairStatus(env: Envelope): void {
    try {
      const { peers: alivePeers } = JSON.parse(env.body) as PairStatusBody;
      const alive = new Set(alivePeers);
      const stale = cfg.paired.map((p) => p.deviceId).filter((id) => !alive.has(id));
      for (const id of stale) {
        if (removePeer(id, "incoming")) log(`对账清理：${id} 不在中继 active 列表（裂脑残档）`);
      }
      if (stale.length === 0) log(`对账无差异（本地 ${cfg.paired.length} 台手机均在中继侧）`);
    } catch (err) {
      log(`⚠ PairStatus 解析失败：${String(err)}`);
    }
  }

  /** 删除本地配对并通知对端/中继（CLI unpair 与桌面「解除绑定」共用一份口径）。
   *  顺序：先发给手机（此刻中继侧配对还在，才能路由），再发给中继删中继侧记录。
   *  reason=incoming（对端发起，不回发通知）/ local（本端发起，发撤销通知） */
  function removePeer(target: string, reason: "incoming" | "local"): boolean {
    log(`removePeer 入口 target=${target} reason=${reason} 在册=${peers.has(target)} 中继就绪=${conn.ready}`);
    if (!peers.has(target)) return false;
    if (reason === "local") {
      // 撤销两帧的发送结果必须可对账：sendPlain 在未就绪时只发 warn 静默丢弃，
      // 这里先打就绪态、后由 conn.warn → log 兜底，两端都能看到才算发出去
      conn.sendPlain(target, T.PairRevoke, { targetDeviceId: target } satisfies PairRevokeBody);
      log(`✂ 已向手机发送 PairRevoke（→${target}）中继就绪=${conn.ready}`);
      conn.sendPlain("relay", T.PairRevoke, { targetDeviceId: target } satisfies PairRevokeBody);
      log(`✂ 已向中继发送 PairRevoke（中继就绪=${conn.ready}）`);
    }
    peers.delete(target);
    onlinePeers.delete(target);
    cfg.paired = cfg.paired.filter((p) => p.deviceId !== target);
    saveConfig(cfg);
    log(`✂ 本地配对已清除并落盘（剩余 ${peers.size} 台手机）`);
    emitter.emit("revoked", target);
    return true;
  }

  function serveSnapshot(peer: PeerKeys, sub: SessionSubscribeBody): void {
    const lines = sub.historyLines ?? 50;
    if (sub.sinceSeq !== undefined) {
      // 断线续传：从 lastAck 偏移读增量
      const r = watcher.readFrom(sub.sessionId, sub.sinceSeq);
      if (r) {
        // 续传同样受 64KB 信封约束：逐组分片 StreamDelta，offset 共用 endOffset
        for (const g of partitionEvents(r.events)) {
          conn.sendSecure(peer, T.StreamDelta, { sessionId: sub.sessionId, events: g, offset: r.endOffset } satisfies StreamDeltaBody, r.endOffset);
        }
        log(`续传 ${sub.sessionId.slice(0, 8)}… 自偏移 ${sub.sinceSeq} → ${r.events.length} 事件`);
      } else {
        // 会话已不在监听列表（转录被删/目录换了）：回空快照结束 App 干等，别沉默
        log(`续传失败：未知会话 ${sub.sessionId}，回空快照`);
        const body: StreamSnapshotBody = {
          sessionId: sub.sessionId,
          events: [],
          offset: sub.sinceSeq,
          truncated: false,
        };
        conn.sendSecure(peer, T.StreamSnapshot, body, sub.sinceSeq);
      }
      return;
    }
    const snap = watcher.readSnapshot(sub.sessionId, lines);
    if (!snap) {
      log(`snapshot 请求失败：未知会话 ${sub.sessionId}`);
      return;
    }
    // 分片：首组保持 StreamSnapshot（truncated 语义只在快照帧上），溢出组走 StreamDelta。
    // App 对两类帧都是 append+seq 取 max，顺序到达即等价（中间不会插同会话其他帧——
    // 这里在订阅连接的同步处理路径内）
    const groups = partitionEvents(snap.events);
    conn.sendSecure(
      peer,
      T.StreamSnapshot,
      { sessionId: sub.sessionId, events: groups[0] ?? [], offset: snap.endOffset, truncated: snap.truncated } satisfies StreamSnapshotBody,
      snap.endOffset,
    );
    for (const g of groups.slice(1)) {
      conn.sendSecure(peer, T.StreamDelta, { sessionId: sub.sessionId, events: g, offset: snap.endOffset } satisfies StreamDeltaBody, snap.endOffset);
    }
    log(`snapshot ${sub.sessionId.slice(0, 8)}… ${snap.events.length} 事件 → ${peer.deviceId.slice(0, 10)}…`);
  }

  conn.on("ready", () => {
    log(`已连上中继 ${relayUrl}`); // 打生效值不打 cfg.relay——--relay 临时覆盖时打配置值会把诊断带沟里（00:28 踩过）
    log(`监听转录目录 ${opts.projectsDir}`);
    // 重连后在线名单以中继重放为准（断线期间的 offline 事件收不到，旧名单不可信）
    onlinePeers.clear();
    watcher.start(); // start 幂等：重连触发第二次 ready 不会起双轮询
    emitter.emit("conn", true);
  });
  conn.on("close", (code: number) => {
    if (code !== 4000) log("与中继断开，自动重连中…");
    emitter.emit("conn", false);
  });
  const KICKED_MESSAGE =
    "⛔ 另一个 larkwire 进程接管了中继连接——同一桥身份同时只允许一个在线（pair 和 watch 不能同时跑）\n   如果是刚开了 pair：配对完成后它会自动退出，再重新运行 pnpm watch 即可";
  conn.on("kicked", () => {
    log(KICKED_MESSAGE);
    shutdown();
    if (exitOnFatal) {
      process.exit(1);
    } else {
      // desktop：进程不退——宿主弹「被顶替」提示，人决定重连或退出
      emitter.emit("fatal", { reason: "kicked", message: KICKED_MESSAGE });
    }
  });
  conn.on("wsError", (err: Error) => log(`连接异常：${err.message}`));
  conn.on("warn", (m: string) => log(`⚠ ${m}`));

  let stopped = false;
  /** 干净停机全集（被踢/信号/handle.stop 同一条路径，幂等）：杀子进程 → 停监听 → 关连接 → 清 pidfile */
  function shutdown(): void {
    if (stopped) return;
    stopped = true;
    controller.shutdown(); // 杀掉在跑的 resume 子进程，别留孤儿
    tmuxAdapter.stop(); // 停 tmux 5s 轮询（WP4 生命周期收尾）
    watcher.stop();
    stopHolderWatch();
    for (const t of doneTimers.values()) clearTimeout(t);
    conn.close();
    removeOwnPidfile();
  }

  if (handleSignals) {
    process.on("SIGINT", () => {
      log("退出");
      shutdown();
      process.exit(0);
    });
    // launchd bootout / 系统关机发的是 SIGTERM 不是 SIGINT——缺了这个 handler，
    // install 形态下 stop 会变成「SIGTERM 默认击杀 + pidfile 陈尸」
    process.on("SIGTERM", () => {
      log("收到 SIGTERM（launchd 停止/关机）→ 退出");
      shutdown();
      process.exit(0);
    });
  }
  // 兜底：任何退出路径（含未捕获异常走默认退出）都尽力清掉自己写的 pidfile
  // （desktop 形态同样写 pidfile——互斥/接管都靠它，进程死必须清）
  process.on("exit", removeOwnPidfile);

  conn.connect();

  return {
    stop(): Promise<void> {
      if (stopped) return Promise.resolve();
      shutdown();
      // 等 ws 真正合上（宿主紧接着可能要干别的在线身份操作）；800ms 兜底防 close 事件丢失
      return new Promise<void>((resolve) => {
        const fallback = setTimeout(resolve, 800);
        fallback.unref();
        conn.once("close", () => {
          clearTimeout(fallback);
          resolve();
        });
      });
    },
    // 实现签名放宽到 any[]（接口上的重载给调用方类型，EventEmitter 逆变要求宽进）
    on(event: string, cb: (...args: any[]) => void): void {
      emitter.on(event, cb);
    },
    snapshot(): BridgeSnapshot {
      return {
        deviceId: cfg.deviceId,
        name: cfg.name,
        relay: relayUrl,
        connected: conn.ready,
        onlinePhones: onlinePeers.size,
        pairedPhones: peers.size,
        pendingPermissions: controller.pendingCount(),
        sessions: watcher.listSessions().map((s) => ({ ...s, occupancy: occupancyOf(s.sessionId) })),
      };
    },
    /** 桌面/CLI 主动解绑一台手机：发撤销通知（手机+中继）+ 删本地配对 */
    revokePeer(deviceId: string): boolean {
      return removePeer(deviceId, "local");
    },
    releaseSession(sessionId: string): boolean {
      // 桌面本地还回（WP5）：只对 phone 态有意义——目标取 phoneHold（受理手机），
      // 非 phone 态（free/desktop/terminal）没有可还的手机，no-op
      const hold = phoneHold.get(sessionId);
      if (!hold) return false;
      const requestId = `lw-desktop-${Date.now()}-${sessionId.slice(0, 8)}`;
      handleRelease(sessionId, hold.to, requestId);
      return true;
    },
    killHolder(sessionId: string): { ok: boolean; pid?: number; reason?: string } {
      // 跳过桥自己影子：桌面 kill-open 绝不能顺手杀自己的持续持有 Runner
      const r = registryKillHolder(sessionId, (p) => controller.isOurChild(p));
      if (r.ok) invalidateOccupancy(sessionId);
      return r;
    },
  };
}
