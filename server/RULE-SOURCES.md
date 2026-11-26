# 分流规则来源与实现边界

核对日期：2026 年 11 月 27 日。

## 官方资料

- Microsoft 365 URL 与 IP 范围：<https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges>
  - 用于确认 Microsoft 登录、SharePoint、Teams、Office 和 Microsoft 365 的域名分类。
  - 具体 IP 段不硬编码进订阅规则，避免官方清单变化后失效。
- Firebase Cloud Messaging 网络配置：<https://firebase.google.com/docs/cloud-messaging/network-configuration>
  - 明确要求关注 `fcm.googleapis.com`、`accounts.google.com`、`iid.googleapis.com`，以及 Android 长连接使用的 `mtalk*.google.com`、`firebaseinstallations.googleapis.com` 等主机。
- Apple APNs 网络说明：<https://support.apple.com/en-us/102266>
  - Apple 设备推送依赖 Apple 网络；Apple 规则保留独立组，并把中国大陆标注的 Apple 域名单独放到国内直连规则前面。
- Claude Code 网络访问要求：<https://code.claude.com/docs/en/network-config>
  - Claude Code 需要独立处理 `api.anthropic.com`、`claude.ai`、`claude.com`、`platform.claude.com`、`sso.claude.com`、`mcp-proxy.anthropic.com`、`downloads.claude.ai` 等主机。
- Anthropic 支持地区：<https://www.anthropic.com/legal/supported-regions>
  - Claude 严选硬门继续采用失败关闭：出口国家必须在支持白名单，不能用 Gemini 或 Google 池代替。

## 社区规则交叉核对

- v2fly domain-list-community：<https://github.com/v2fly/domain-list-community/tree/master/data>
  - `microsoft`、`apple`、`googlefcm` 和 `cn` 数据用于核对 geosite 标签及中国大陆子集。
- blackmatrix7 ios_rule_script：<https://github.com/blackmatrix7/ios_rule_script/tree/master/rule/Clash>
  - Microsoft、Apple、Google 和 Claude 的 Clash 规则用于补充 CDN、登录和遥测域名。
- zhanyeye clash-rules-lite Microsoft 规则：<https://github.com/zhanyeye/clash-rules-lite/blob/main/microsoft-rules.txt>
  - 用于交叉检查 Azure、Microsoft 登录、OneDrive、Xbox 和 Office 相关后缀。

## 当前实现

- `Claude` 规则独立走 `Claude` 组；只允许同时通过四个 Claude 端点、出口国家、IP 共识、稳定性和 IPv6 纯度硬门的节点进入 `Claude-严选`。
- `FCM` 规则排在宽泛 Google 规则之前，避免 FCM 长连接被 Google 总组吞掉。
- FCM 组默认首选 `国内直连`：Firebase 官方说明 Android 推送长连接不能通过网络代理，代理只保留为注册/API 等流量的手动备用路径。
- Microsoft 和 Apple 的 `@cn` geosite 规则与中国域名规则先于各自海外大组；未被中国子集明确覆盖的全球服务进入独立组。
- `GEOSITE,cn` 与 `GEOIP,CN` 仍是最后的国内直连兜底；最终 `MATCH` 继续进入 `漏网之鱼`，不产生隐式 DIRECT。
