# Android 客户端 (MVP)

## 构建要求
- Android Studio Iguana/Koala，Java 17。
- 目标/编译 SDK 34，最小 21 (Android 7.0/7.1)。

## 快速开始
1. 用 Android Studio 打开本目录（`android-client`）。首次会提示生成 Gradle Wrapper，选择“OK”即可。
2. 修改 `app/build.gradle` 中的 `WS_URL`，填入你 NAS 的 WebSocket 地址，例如：
   ```groovy
   buildConfigField "String", "WS_URL", '"ws://192.168.1.50:8080/ws"'
   ```
3. 在 Build Variants 里选择 `leftDebug` / `centerDebug` / `rightDebug`，对应三块屏。
4. 点击 Run ?? 将 APK 装到对应屏幕；或 Build > Build APK(s) 获取 `app/build/outputs/apk/<flavor>/` 下的 APK。

## 运行时说明
- App 开机自启（可在系统设置里设置“允许自启动”）。
- 连接到控制端后会显示 `Connected`。
- 默认按 `WS_URL` 自动连接；连接失败可用遥控 / D-Pad 按“确定”重试。
- 底部“Role”按钮可切换左右中角色，切换后还会发送 hello。
- 收到 `play` 消息时预加载并在指定 UTC 毫秒时间启动；中屏默认有声，左右静音。
- 收到 `power` 的 `sleep|wake|reboot` 目前仅做暂停/恢复提示，真实关机需系统签名或 MDM 权限。

## WebSocket 消息格式（与控制端一致）
- 发送：`{"type":"hello","deviceId":"...","role":"left|center|right"}`
- 接收：
  - `welcome|synctime { serverTime }`
  - `play { programId, startAtUtcMs, loop, screens: { left|center|right: { url, effect, audio } } }`
  - `stop`, `power { action }`

