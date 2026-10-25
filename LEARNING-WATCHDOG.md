# 学习批次监控：范围、停机与验证边界

不创建 cron、Windows 计划任务或服务；import 不激活监控。

## 范围与策略

`并行学习.ps1 -Monitor -Accounts account-A -Daily:$false -MaxAccounts 1` 转发为 batch 的 `--accounts=account-A --daily=false --max-accounts=1`。Status 也转发范围，保留 Node 退出码。默认 newest-single/daily；非 daily 使用主学习器非 daily 目标策略。账号按原始 profile/user 匹配，空匹配或超过 MaxAccounts 明确失败，不回退全体。

正常 batch 先独占取得全项目 monitor 锁，再写当日本地午夜到期的 arm，包含 `accountKeys` 和 `policy:{daily,newestSingle:true}`，不含密码。恢复只限列表内账号并沿用策略。旧版无范围/策略的 arm 不允许恢复，需要下一次显式启动重新授权。过期不延长，观察进程不是授权。

启动是同一条 `runBatch → startLearningBatch` 路径：**lock → arm → 所有原始 child 的 spawn 确认 → monitor.start/tick**。锁被其他批次/attach 占用时明确失败 `MONITOR_ALREADY_RUNNING`（CLI 非零退出），零 spawn，原授权字节不变，不静默退化成无监管学习。锁取得后监控处于暂停态，`wake()` 也不执行观察，防止原始 child 尚未启动被误判为缺失。

初始化或启动失败会停止本次新建 child，等待其 close，仍持有自己的锁时原样恢复之前 arm（之前不存在则移除本次授权），最后释放自己的锁；失去所有权后不覆写 arm、不删除继任锁。错误日志父进程 fd 在 spawn 确认/失败后关闭。不能保证强制终止进程或磁盘故障时完成回滚，相关状态需人工检查。

## 生命周期与所有权

batch 约30秒监控一次；退出钩子写事件并唤醒。正常汇总等待原始 child、所拥有恢复 child 及监控完成。

attach 不接管已经存在的学习器/浏览器。只有自己新增 child 归本次 owner。stop/Ctrl+C 通过存活 child handle 停止所属学习器，不对历史 PID kill，不关闭用户浏览器，不全局清理。停止期间禁止补启；在途启动返回后也归停止中的 owner，批次等待监控结束再退出。

`--once --dry-run` 为只读真实进程/日志观察，不写、不锁、不启动、不通知。非 dry-run 的 `--once` 有副作用。默认/attach 是学习范围监控，不是永久守护。整个批次被强制结束不能保证在途处理完成；fatal hook 只尽力持久化与通知，不压制异常。

## 日志与停止原因

新日志与错误日志使用 paths.key。旧脱敏日志仅完整账号清单中唯一归属时认领；同 mask 多账号绝不使用旧文件作进度/完成/恢复证据；唯一旧账号进度仍保留。独立退出钩子不提供 identityAccounts 时默认不认领旧文件。

机器标记 `LEARNING_STOP_REASON=manual-required|no-gain` 为保护停机，需人工确认，不恢复、不算完成；`daily-limit` 在可信事件日期认定对应日达限；`completed` 是正常本轮结束。兼容旧拒绝拖拽、连续2门无新增、达到目标、无待学课程及正常结束处理门数文案。疑似限额不是确认达限，尾部普通结束行不覆盖保护原因。`retryable-failure` 机器标记优先于普通结束文本，保持异常恢复资格。

恢复要求观察有效、学习器/对应浏览器均不存在、冷却至少120秒、30分钟内尝试少于3次。观察未知不启动，浏览器仍在不启动也不关闭。spawn 成功仅 restart-pending，必须新播放日志才确认恢复。

## 持续低速与卡顿自愈（默认启用）

`auto-learn.mjs` 的真实 `playCourse` 主循环每2秒读取实际视频进度，按墙钟计算非重叠60秒窗口，不以“偶尔推进了一点”清空低速证据。每门课先给30秒宽限；连续两个完整窗口速度低于0.60倍即判持续低速。

1. 首次持续低速：写 `PLAYBACK_HEALTH=reload`，仅重载当前媒体，等待 metadata 后恢复重载前的真实 currentTime，保持1倍速；15秒超时视为重载失败。每门课最多进行一次此类低速重载。
2. 重载后另给30秒宽限，重新观察两个完整窗口；仍连续低于0.60倍、或重载失败，写 `PLAYBACK_HEALTH=restart`，返回 `restartRequired`。main 保存可重试状态、写 `LEARNING_STOP_REASON=retryable-failure` 并关闭自身浏览器，不误记课程完成，也不静默跳过该课。
3. 原有完全停滞25/50/80秒恢复仍保留；80秒重载复用等待metadata并恢复位置的安全实现。120秒仍不恢复，也请求上述单账号重启。
4. 既有batch监控仅在 learner和对应browser均消失后沿用当日授权补启；每账号至少间隔120秒，30分钟最多3次，达到限制告警并暂停，不无限重启。独立运行auto-learn而没有batch/attach时只会安全退出，不自行创建常驻监督器。
5. 连续两个完整60秒窗口速度至少0.85倍后，才写 `PLAYBACK_HEALTH=recovered` 并产生“卡顿恢复”事件；重启后续播相同故障课程也须重新验证。仅spawn/新播放日志的“学习恢复”通知不等于速度恢复。
6. 随堂答题、视频缺失、时间倒退/跳变、睡眠导致的采样长间隔会清空计时并重新宽限，不把这些当作低速或恢复。正常换课使用新的独立监控状态；不动其他账号、不改全局代理/缓存、不加速或伪造进度。日上限和人工保护停机沿用原有禁止补启逻辑。

卡顿、升级处理和速度恢复事件通过 `recordPlaybackEvent` 进入既有不可变learning-alerts队列，由批次监控排空；不新建cron、计划任务或服务。启动后默认启用，旧进程不热加载。回归覆盖纯策略、实际playCourse循环、实际main退出路径、位置恢复和通知队列；模拟故障测试不能冒充真实站点故障恢复验收。

## 看板与汇总

`generateDashboard` 已改 async，默认合并只读 Windows 进程观察。纯 parseAccountLog 仅历史解析，不证明实时状态。死进程不报播放；未知明确未知；日志陈旧/日期不明不报实时播放；旧日达限仅历史。

gain 为本地今日日志覆盖区间累计，runGain 为最新一轮，完成数按同一本地日事件。重复日志/重叠学分区间去重；有课程 ID 的同日完成去重。不能证明日志未覆盖时段的学习量。跨午夜学分采样区间/时间缺失标未知或不可归因，不拆虚假精确值；时间明确的完成事件仍可计数。

汇总 `summary-本地日期-时间戳-UUID.md` 独占创建，不覆盖。同目录 cmd 先建 logs 再重定向。

## 进程观察退出竞态与诊断

Windows CIM 可能在进程刚退出时仍返回 PID，但 CommandLine 为空。不能过滤该行后声称学习器不存在：不可读但存活的学习器也可能出现同样表现。

`enumerateProcesses({exec,delay,platform})` 对缺项、查询失败及不可解析输出最多取3次全新快照，重查间隔250ms，每次查询仍限15秒。只有完整快照才返回 known=true；重试耗尽仍 unknown，禁止补启。错误只保留固定分类，不保留命令行、stdout/stderr、异常原文或密码。

观察失败第一次只记录诊断；连续2轮失败才产生一次告警，成功观察清零；持续同一事件不重复通知。监控的未知终态也使用各账号自己的连续失败计数（至少3轮），不得把A/B/C不同账号各一次失败累加成全局终止；全局异常计数仅用于监控执行或持久化异常。health 的 observerVersion=2，账号含 unknownTicks 与脱敏 observer 诊断。失败或重试后恢复的快照会追加到 `logs/learning-observer-diagnostics.jsonl`，保留时间、耗时、次数、固定错误分类及缺项进程名/PID；dry-run不写诊断。

运行中的旧batch不热加载修改，不为加载新版打断课程；后续启动自动使用新实现。单元/整合测试覆盖短暂缺项恢复、持续失败零spawn、告警阈值去重、成功清零、错误分类和诊断隐私。独立自有短命进程实测可以复现缺项并验证重新查询恢复，不对真实学习进程做故障注入。

## 通知和持久化

告警解释器不再写死：`notifyGateway` 依次尝试 `LEARNING_ALERT_PYTHON`、各 `installs/*/environments/*/venv/Scripts/python.exe`（新→旧）、`hermes-agent/venv/...`；Hermes 升级替换环境目录后仍可投递，全部失败才 `NOTIFIER_FAILED`。运行中的旧监控不热加载，可用同路径 junction 临时恢复投递，无需重启学习。

state/health 原子替换，启动前预留重试。learning-alerts/<id>.json 是不可变 {id,created_at,message}；pending/sent 去重。全项目单 monitor 锁，活锁/格式异常不抢占；陈旧锁恢复围栏崩溃可能需人工确认。

外部 learning_gateway_alerts.py 通过 execFile，单次20秒超时；未修改 helper/网关。startBatchMonitor 每轮（包括每次异常）有界通知，默认3次、间隔1秒；首次失败新增的通知故障事件也纳入后续排空。helper 返回成功但 pending 未归档，仍不能称送达。

终态同样完成有界排空；耗尽记录 `notifier:{ok:false,error:'UNDELIVERED_LOCAL',pending,attempts}` 并保留本地事件，不宣称网关已接手/送达。不会创建永久重试进程。fatal 退出时异步投递仍仅 best-effort。

## 注入接口

- parseBatchOptions(args), selectBatchAccounts(accounts,options)
- generateDashboard(accounts,{root,identityAccounts,now,observe}) → Promise<rows>
- observeAccounts({root,accounts,identityAccounts,now,enumerate})
- armLearningRun(root,now,{accounts,daily})
- tick({root,accounts,identityAccounts,now,owner,isStopping,observe,launch,dryRun})
- launchAccount(account,root,spawnFn,policy) → {pid,proc}
- createChildOwner(), stopOwnedBatch(owner,monitor)
- runBatch({args,identityAccounts,root,spawnFn,monitorOptions})：真实 CLI 入口可注入 fixture；冲突抛出，不注册运行期 timer/hook
- startLearningBatch({root,accounts,identityAccounts,daily,watchdogApi,spawnFn,monitorOptions}) → Promise<{children,owner,monitor,exits,watchdogApi}>；事务式启动，不允许无 monitor 降级
- startBatchMonitor({root,accounts,owner,deferStart,tickFn,notify,retryDelayMs,deliveryAttempts,...tickOptions}) → {done,health,finished,stop,wake,start,ownsLock}；锁占用返回 null。`deferStart:true` 只预留所有权，`start()` 幂等启动观察，失锁抛出 `MONITOR_LOCK_LOST`
- drainNotifications(root,notify,options), saveSummaryReport(root,report,now)

## 验证边界

fixtures 覆盖真实日志选择、时间归属、观察合并、恢复决策；枚举/spawn/通知注入替身。PowerShell 转参与 cmd 重定向使用隔离目录无害 stub。本轮没有真实学习、真实浏览器观察/操作、真实通知或端到端恢复验收。网关最终送达、Windows 学习器终止及站点业务仍需另行明确授权验收。
