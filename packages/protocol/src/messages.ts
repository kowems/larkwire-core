/**
 * 各消息类型的 body 载荷定义（解密后的 JSON 形状）。
 */
import type { UiEvent } from "./uievent.js";

// ---------- 配对（架构 §2.3 状态机；body 明文，见 envelope.ts 注释） ----------

export interface PairOfferBody {
  token: string; // 一次性，10 分钟
  publicKey: string; // 桥公钥 base64（本体走握手交换，URL 里只放指纹）
  name: string; // 桥设备名
}

export interface PairAcceptBody {
  token: string;
  publicKey: string; // 手机公钥 base64
  name: string; // 手机名
}

/** 中继回给手机的 accept 回执：桥公钥本体走这里交换（手机凭 QR 指纹校验） */
export interface PairAcceptAckBody {
  token: string;
  bridgeDeviceId: string;
  bridgePublicKey: string;
  bridgeName: string;
}

/** confirm 走 E2E 密文：只有双方密钥推导一致才解得开 = 密钥握手自验证 */
export interface PairConfirmBody {
  ok: true;
  bridgeName: string;
}

export interface PairErrorBody {
  token?: string;
  stage: "offer" | "accept" | "confirm";
  reason: string;
}

export interface PairRevokeBody {
  targetDeviceId: string; // 被踢掉的设备
}

/** #83：中继鉴权后下发的对账单——本设备当前全部 active 对端 deviceId。
 *  设备侧把本地配对与此列表比对，不在其中的一律清掉（中继是配对唯一事实源） */
export interface PairStatusBody {
  peers: string[];
}

// ---------- 会话 ----------

export type AgentKind = "claude-code" | "codex" | "tmux" | "unknown";
export type SessionMode = "watch" | "wrap" | "resume"; // 看 / 控 / 接

export interface SessionRegisterBody {
  sessionId: string;
  agent: AgentKind;
  mode: SessionMode;
  project: string; // 项目目录名（如 "被动收入创意谷"）
  cwd?: string;
  title?: string; // ai-title 或首条用户消息摘要
  startedAt: number; // 转录文件首行 ts 或文件 ctime
  lastActiveAt: number;
}

export interface SessionUpdateBody {
  sessionId: string;
  title?: string;
  lastActiveAt?: number;
}

export interface SessionSubscribeBody {
  sessionId: string;
  sinceSeq?: number; // 断线重连：从此 seq 之后补
  historyLines?: number; // 首次打开：回放末尾 N 行（默认 50）
}

// ---------- 输入（M1 控模式） ----------

/** 手机发话：往指定会话注入一条用户消息（桥侧一次性 resume 子进程跑这条） */
export interface InputSubmitBody {
  sessionId: string;
  text: string;
  clientMsgId: string; // App 生成的 uuid：ack 配对 + 重发去重
}

/** 桥受理回执。ok=false 只是拒收（此刻不能跑），不代表消息本身有问题 */
export interface InputAckBody {
  sessionId: string;
  clientMsgId: string;
  ok: boolean;
  reason?: string; // 拒收原因，人话，App 直接 toast（如「会话正在电脑上活跃」「上一条还在跑」）
  occupiedPid?: number; // M1.5：拒收原因是「会话被电脑端进程占用」时带上持有进程 PID——App 凭此显示「抢夺控制权」按钮（结构化标记，不靠文案匹配）
  /** ok=true 时明示注入通道（批次③ WP1 additive）：resume=桥起影子进程；tmux=注入终端 pane。
   *  缺省=resume（旧桥只有 resume），App 可用于状态条提示 */
  via?: "resume" | "tmux";
  /** ok=false 的失败阶段：runFail=受理后跑挂（回合已死，App 停忙碌指示器）；
   *  缺省=即时拒收（回合没开始，不影响别的 run 的忙碌态）。additive，旧桥不发 */
  phase?: "runFail";
}

// ---------- 接管（M1.5） ----------
// 手机「抢夺控制权」：桥杀掉电脑端持有该会话的交互进程（注册表/procStart/kind/comm 四重验证 +
// SIGTERM 优雅杀，不自动 SIGKILL），占用闸门打开后 App 自动重发刚才被拒的话。
// 反向（手机→电脑）走下面「控制权归属」三帧：回合结束自然归还（零动作），回合进行中用 session.release。

/** 手机发起抢夺。requestId = App 生成的 uuid，ack 配对 */
export interface SessionTakeoverBody {
  sessionId: string;
  requestId: string;
}

/** 桥抢夺回执。ok=true 含幂等情形（本就没人占用）；killedPid 便于 App 展示「已关掉 PID xxx」 */
export interface SessionTakeoverAckBody {
  sessionId: string;
  requestId: string;
  ok: boolean;
  reason?: string; // 失败原因，人话，App 直接 toast（如「3 秒没退，请到电脑上 /exit」）
  killedPid?: number;
}

// ---------- 控制权归属（A+B，2026-09-19 Eric 拍板：简化手机→电脑的切回） ----------
// A=手机一键「还回电脑」：session.release 杀掉进行中的 run（没在跑=幂等 ok，本就近乎零动作）。
// B=坐下即用：回电脑开窗 → 桥注册表 watcher 探测到新持有者 → 有 run 杀 run 让位，
//   推 session.owner=desktop。owner 推送是 App 状态条的依据：
//   desktop=电脑端窗口持有（发话会被占用闸门拒收，⚡可抢回）；none=无人持有。

/** 桥→手机：会话当前持有者状态。四态（批次③ WP1 扩枚举，additive）：
 *  desktop=电脑端窗口持有（发话会被占用闸门拒收，⚡可抢回），带持有者 PID；
 *  terminal=tmux 终端里的活会话（S12 关联到 claudePid；手机发话走 tmux 注入不拒收，App 无抢夺钮）；
 *  phone=手机持有中（另一台手机受理了 run / 回合后未还回）；
 *  none=无人持有。note 只在打断手机回合时带人话说明（App toast）。
 *  旧 App 遇新枚举值：横幅不落分支、不炸（Record 运行时宽容）。 */
export interface SessionOwnerBody {
  sessionId: string;
  owner: "desktop" | "terminal" | "phone" | "none";
  pid?: number;
  note?: string;
}

/** 手机→桥：还回电脑。requestId = App 生成的 uuid，ack 配对 */
export interface SessionReleaseBody {
  sessionId: string;
  requestId: string;
}

/** 桥还回回执。interruptedRun=false = 本就闲着（幂等 ok），App 文案据此区分。
 *  scheduled=true（2026-09-20 Eric 拍板温和还回）：回合还在跑，不中断——已预约，
 *  回合自然说完后桥会再发一个同 requestId 的最终 ack（scheduled 缺省）= 交接完成 */
export interface SessionReleaseAckBody {
  sessionId: string;
  requestId: string;
  ok: boolean;
  reason?: string;
  interruptedRun?: boolean;
  scheduled?: boolean;
}

// ---------- 权限接力（M1） ----------
// 帧格式实证见 S10 spike（tools/s10-spike.mjs）：--permission-prompt-tool stdio 下
// claude 把 can_use_tool 作为 control_request 递到 stdout，批准/拒绝写回 stdin。

export interface PermissionRequestBody {
  sessionId: string;
  requestId: string; // = control_request.request_id，respond 时原样带回
  tool: string; // tool_name（Bash/Write/…）
  description?: string; // claude 给的一句话说明
  inputSummary: string; // input 的人话摘要（桥侧截断 500）
  inputJson: string; // input 完整 JSON（截断 2000，App 折叠展示）
  suggestions?: string[]; // permission_suggestions 里的人话摘要（如「加入本地允许规则」）
}

export interface PermissionRespondBody {
  sessionId: string;
  requestId: string;
  behavior: "allow" | "deny";
  message?: string; // deny 时给 claude 的拒绝理由（会出现在 tool_result 里）
}

/** 请求已了结（非本手机答复）：超时自动拒/回合结束撤/桥代拒/另一台手机已答 → App 按 requestId 撤卡（幂等） */
export interface PermissionResolveBody {
  sessionId: string;
  requestId: string;
  outcome: "expired" | "cancelled" | "auto_denied" | "answered";
  note?: string;
}

// ---------- 流 ----------

export interface StreamDeltaBody {
  sessionId: string;
  events: UiEvent[];
  offset: number; // 看模式：本批最后一行的转录字节偏移（= 本信封 seq）
}

export interface StreamSnapshotBody {
  sessionId: string;
  events: UiEvent[];
  offset: number;
  truncated: boolean; // true = 只回了末尾 N 行，前面还有
}

export interface StreamAckBody {
  sessionId: string;
  lastSeq: number;
}

// ---------- 在场（中继代发，明文） ----------

export interface PresenceBody {
  deviceId: string;
  name?: string;
  online: boolean;
}

// ---------- 通知（M3；level 明文走信封外字段？——v1 先放 body，中继只见 type） ----------

export type NotifyLevel = "urgent" | "done" | "info";
export interface NotifyRequestBody {
  level: NotifyLevel;
  sessionId?: string;
  text: string;
}

// ---------- 计量 ----------

export interface MeterAckBody {
  day: string; // YYYY-MM-DD
  bytesOut: number;
  msgsOut: number;
}
