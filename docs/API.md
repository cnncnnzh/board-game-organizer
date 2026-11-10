# HTTP API

Base URL：`/api/v1`。所有写请求使用 JSON 对象和 `Content-Type: application/json`。浏览器调用同域 API，自动携带 `bg_session` Cookie；跨站写请求被拒绝。

## 响应与身份

成功响应使用 HTTP 200 和 `data`，只有 `/openapi.json` 直接返回原始 OpenAPI JSON：

```json
{"data":{"joined":true}}
```

失败响应携带有意义的 HTTP 状态及稳定错误码：

```json
{"error":{"code":"NAME_TAKEN","message":"这个姓名已在活动中使用，请加上可辨认的后缀；姓名不能用于找回他人的报名"}}
```

不需要登录或账号。`GET /session` 中的 `participant` 是浏览器的基础匿名身份；`GET /events/:code` 的 `participant` 和 `currentParticipantId` 是当前活动的有效身份。管理密钥恢复可能使两者不同，但只对该活动生效。

创建活动、创建匿名会话、首次加入活动或首次恢复管理权限时，服务端可设置 HttpOnly Cookie。服务端从 Cookie 推导身份；请求体中的操作者 ID、姓名或 role 不能代替凭证。

活动码为 8 位不易混淆的大写字母/数字；输入会去除空格和连字符并转为大写。普通活动链接为 `/events/CODE`。持有链接或码即可读取该活动名单，无全站活动列表。

## 全部端点

表中的路径均相对于 `/api/v1`。`member` 表示已在该活动填写姓名且具有有效浏览器凭证的成员；`host` 指该桌创建者；owner/admin 也必须具有对应活动的凭证。

| 方法与路径 | 请求体 | 权限 / 结果 |
| --- | --- | --- |
| `GET /session` | 无 | 公开；`{participant:null}` 或 `{participant:{id,displayName}}` |
| `POST /session` | `{displayName}` | 创建基础匿名身份或修改基础显示名；设置 Cookie，返回 participant |
| `POST /events` | 活动字段和 `displayName`，见下 | 公开；新建活动和 owner 身份，返回 `{event,managementKey}` |
| `GET /events/resolve/:code` | 无 | 公开；校验活动存在，返回 `{code}` |
| `GET /events/:code` | 无 | 公开；返回完整活动视图及当前浏览器权限 |
| `GET /events/:code/results` | 无 | 公开；同活动视图；到期时补做结算，未截止时仍返回 open 视图 |
| `POST /events/:code/members` | `{displayName}` | 创建/使用匿名会话，将该身份加入本活动或更新活动内显示名；返回 `{joined:true}` |
| `PATCH /events/:code` | 可修改的活动字段 | owner/admin；返回 `{updated:true}` |
| `DELETE /events/:code` | 无 | owner/admin，且报名期内；级联删除活动，返回 `{deleted:true}` |
| `POST /events/:code/finalize` | 无或 `{}` | owner；正式环境可用，无需测试开关。立即截止并按自然到期规则结算，返回 `{result}`。保留已入席成员、seed 及活动起止时间；截止未到时改为当前时间，冻结报名与桌游，允许无桌游活动。重复调用返回已保存汇总，不重新分配 |
| `POST /events/:code/manage` | `{managementKey,displayName?}` | 持有密钥；恢复本活动 owner 身份，必要时建立基础会话；返回 `{recovered:true}` |
| `POST /events/:code/management-key` | 无或 `{}` | owner；轮换密钥并撤销其他恢复授权，返回 `{managementKey}` |
| `PUT /events/:code/admins/:id` | `{isAdmin:true}` 或 `{isAdmin:false}` | owner；目标是本活动真实成员且不是 owner，返回 `{updated:true}` |
| `POST /events/:code/owner-transfer` | `{participantId}` | owner；转给另一名本活动真实成员，返回 `{ownerId}`；不向原 owner 返回新密钥 |
| `POST /events/:code/games` | 桌游字段，见下 | member，报名期内；创建桌游并让 host 入席，返回 `{gameId}` |
| `PATCH /events/:code/games/:id` | 可修改的桌游字段 | host，报名期内；扩容后补位，返回 `{gameId,promotedCount}` |
| `DELETE /events/:code/games/:id` | 无 | host，报名期内；释放该桌全部报名，返回 `{deleted:true}` |
| `POST /events/:code/games/:id/registrations` | 无或 `{}` | member，报名期内；返回 `{gameId,status}`，status 为 `attendee` 或 `waitlist` |
| `DELETE /events/:code/my-registration` | 无 | member，报名期内且不是 host；返回 `{dropped:true,promotedCount}` |
| `POST /events/:code/preview` | 无或 `{}` | owner + 测试工具启用；只读分配预览，返回 `{games,unassigned,result}` |
| `POST /events/:code/test-users` | `{count}`，1–30 | owner + 测试工具启用；活动内最多 50 个测试身份 |
| `POST /events/:code/test-games` | 桌游字段 | owner + 测试工具启用；创建测试 Host 和其桌游 |
| `POST /events/:code/games/:id/test-users` | `{count}`，1–30 | owner + 测试工具启用，报名期内；一次创建测试玩家并报名本活动指定桌游，满员后候补。返回 `{createdCount,participantIds,gameId,attendeeCount,waitlistCount}`，活动内最多 50 个测试身份（含 Host） |
| `POST /events/:code/test-finalize` | 无或 `{}` | owner + 测试工具启用；须有至少一个桌游。模拟立即截止并复用正式结算，返回 `{result}`。保留 seed 及活动开始/结束时间，原截止尚未到达时改为当前时间；重复调用返回已保存汇总，不重新分配 |
| `POST /events/:code/test-fill` | 无或 `{}` | owner + 测试工具启用；轮流向各桌报名未报名测试成员，返回 `{joinedCount,attendeeCount,waitlistCount}` |
| `POST /events/:code/test-users/:id/join` | `{gameId}` | owner + 测试工具启用；模拟指定测试成员报名，返回 `{gameId,status}` |
| `POST /events/:code/test-users/:id/drop` | 无或 `{}` | owner + 测试工具启用；模拟指定非 host 测试成员退出 |
| `POST /events/:code/test-reuse` | 无或 `{}` | owner + 测试工具启用；重新加入当前 owner 复用池中没有活动关联的测试身份，返回 `{reusedCount}`，活动内上限仍为 50 |
| `DELETE /events/:code/test-users` | 无 | owner + 测试工具启用；删除本活动测试成员，按删桌规则清理关联报名，返回 `{deletedUserCount}` |
| `DELETE /events/:code/test-event` | 无 | owner + 测试工具启用；删除活动及报名，将测试身份保留到当前 owner 的复用池，返回 `{deleted:true,testUsersRetained:true}` |
| `GET /health/live` | 无 | 公开；`{status:"ok"}` |
| `GET /health/ready` | 无 | 公开；查询数据库后返回 `{status:"ok",database:"pglite"}` 或 `postgres` |
| `GET /openapi.json` | 无 | 公开；直接返回 OpenAPI 3.1 JSON，包含请求体、路径参数和活动视图等响应 schema，不包裹 `data` |

测试工具只在非生产环境且 `ENABLE_TEST_TOOLS=true` 时启用，服务端仍要求 owner。管理员不能调用。测试身份不拥有浏览器登录凭据，不能被提升为管理员或 owner。

## 创建和编辑活动

```json
{
  "displayName":"小陈",
  "title":"周六桌游",
  "location":"社区活动室",
  "startAt":"2027-01-16T19:00:00-06:00",
  "endAt":"2027-01-16T23:00:00-06:00",
  "timeZone":"America/Chicago"
}
```

- 首次创建匿名身份时必须提供 `displayName`；已有身份可沿用基础显示名。
- 姓名最多 40 字，经 NFKC 规范化与 trim，不能有换行或控制字符；同一活动的规范姓名不区分大小写且必须唯一。
- 活动标题最多 40 字，未填时默认“桌游聚会”；地点必填，最多 100 字。
- `startAt`、`endAt` 必须是含 `Z` 或明确 UTC offset 的 ISO 日期时间；返回值统一为 UTC ISO 字符串。`timeZone` 是 IANA 时区，默认 `America/Chicago`。
- 新建和报名期编辑时，开始必须严格晚于服务端当前时间加 24 小时。结束晚于开始，总时长不超过 3 天。
- `PATCH` 可只提交需更新字段。已结算活动可更正展示时间地点，但原截止、seed 和分配结果保持冻结，不重新开放报名。
- 所有活动互相独立，没有全站单活动限制。

响应中的 `managementKey` 是管理恢复秘密，仅在生成时返回明文，数据库仅保存哈希。不要放进普通活动链接、活动码、日志或公开名单。

## 匿名加入与姓名变更

```json
{"displayName":"小王（周六群）"}
```

直接 `POST /events/:code/members` 即可在无会话时创建匿名凭证并加入活动，不必先调用 `/session`。

`POST /session` 修改浏览器的基础默认姓名，不会自动修改已加入活动中的名字。要更新某活动内姓名，调用该活动的 `/members`。管理恢复授权有效时，这一操作作用于活动内恢复后的有效身份，而不是另一名基础匿名身份。

同名冲突返回 `NAME_TAKEN`，不会接管同名成员。清除 Cookie 后的普通报名不能仅凭姓名找回；凭证代表同一浏览器身份，不能识别跨设备的同一个真实的人。

## 桌游字段与报名

```json
{
  "name":"卡坦岛",
  "capacity":4,
  "description":"带基础版，欢迎新手",
  "difficulty":"入门"
}
```

名称必填、最多 50 字；容量为 1–100 的整数，包含 host；简介最多 500 字，难度最多 20 字，后两项可为空。编辑可只提交变化字段。

创建桌游会同时创建 host 的 `attendee` 报名。同一活动内已有任何报名的人，需先退出才可开桌或报名另一桌。host 不允许普通退出，只能在报名期删除自己的桌。删桌使其全部入席和候补报名删除，但活动成员身份保留。

普通报名返回 `attendee` 或 `waitlist`。退出入席或扩容时按注册顺序晋级候补，`promotedCount` 是晋级人数；缩容不能低于当前入席人数。

## 活动视图

`GET /events/:code` 和 `/results` 的 `data` 包含：

| 字段 | 说明 |
| --- | --- |
| `event` | `id,code,title,location,startAt,endAt,timeZone,registrationClosesAt,status,finalizedAt,ownerId,result,role,canManage,isMutable` |
| `participant` | 当前活动内有效身份 `{id,displayName}`，未加入为 `null` |
| `currentParticipantId` | 当前活动内有效 participant ID，未加入为 `null` |
| `registration` | 当前身份的报名或 `null` |
| `games` | 稳定排序的桌游列表，含 host、入席和候补名单 |
| `unassigned` | 结算后无可用席位的报名列表 |
| `members` | 活动内成员 `{id,displayName,role,isTest}` |
| `testToolsEnabled` | 仅环境启用且当前有效角色为 owner 时为 true |
| `serverTime` | 服务端当前时间，Unix 毫秒 |

`event.status` 为 `open` 或 `finalized`；`role` 为 `guest`、`member`、`admin`、`owner`。`isMutable` 同时检查状态和截止时间，不以页面按钮代替后端验证。

每桌包含 `id,name,capacity,description,difficulty,hostId,hostName,isHost,attendees,waitlist`。`isHost` 相对于当前活动有效身份。

报名项包含 `id,participantId,displayName,primaryGameId,finalGameId,status,isHost,allocationReason`。候补项另有 1 起始的 `rank`。状态为 `attendee`、`waitlist` 或 `unassigned`；正式结算后的分配原因为 `primary`、`balanced` 或 `null`。

正式结算汇总 `result` 包含 `gameCount,attendeeCount,assignedFromWaitlist,unassignedCount`。分配预览返回各桌的预期入席者和相同结构的汇总，但不会写入正式结果。

## 管理恢复、轮换与转让

恢复示例：

```json
{"managementKey":"保存的43字符密钥"}
```

若浏览器还没有基础身份，会自动创建。恢复仅对指定活动建立授权，允许以当前 owner 身份管理该活动，不会获得同一 owner 在其他活动中的权限。

`POST /management-key` 会生成新的密钥、使旧密钥失效，并撤销该活动其他恢复浏览器的授权。调用本次轮换的恢复浏览器继续有管理权。

转让使用 `{participantId}`，目标为本活动另一位真实成员。转让事务会将旧 owner 降为 admin、目标升为 owner、轮换密钥并撤销全部恢复授权。转让响应不返回新密钥给旧 owner；新 owner 使用自己的凭证调用 `/management-key` 保存新的恢复密钥。

## 截止、清理和错误

报名截止是开始前实际 24 小时；服务端拿到活动锁后再次检查，超过截止不能创建/修改/删除桌游或加入/退出报名。到期活动读取时补做结算，任务也每 5 分钟检查一次。

结束后实际 24 小时由周期任务删除活动及其关联数据。可能存在一个任务周期内的清理延迟；清理后普通链接、活动码、管理密钥都不能再访问该活动。其他活动不受影响。

| HTTP 状态 / 错误码 | 含义 |
| --- | --- |
| 400 `INVALID_INPUT`, `INVALID_CODE` | 字段无效或活动码格式不正确 |
| 401 `NAME_REQUIRED` | 缺少匿名身份或本活动成员身份 |
| 403 `FORBIDDEN` | 非 owner/admin/host 等权限不足 |
| 403 `INVALID_KEY` | 管理恢复密钥不正确或已轮换 |
| 403 `CSRF_REJECTED` | 跨站写请求 |
| 403 `TEST_TOOLS_DISABLED` | 测试工具未启用 |
| 404 `NOT_FOUND` | 活动、桌游或目标成员不存在/已清理 |
| 409 `NAME_TAKEN`, `ALREADY_REGISTERED` | 姓名冲突或已有主选报名 |
| 409 `EVENT_CLOSED`, `HOST_MUST_DELETE` | 已截止，或 host 需要通过删桌退出 |
| 409 `CONFLICT`, `BUSY` | 数据约束冲突、活动正在更新，刷新/重试 |
| 415 `INVALID_CONTENT_TYPE` | 写请求不是 JSON |
| 429 `RATE_LIMITED` | 请求频率过高 |
| 500 `INTERNAL_ERROR` | 服务内部错误，响应不暴露数据库详情 |

写入有输入长度和 16 KiB 请求体限制。全局限流为每分钟 300 次/来源；创建身份/活动和管理密钥等敏感入口另设每分钟 30 次限制。客户端应在 409 时刷新活动，在 429 时等待后重试，不自动无限重发。
