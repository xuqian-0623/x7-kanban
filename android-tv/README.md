# X7 项目看板电视端

这是面向 Android 6.0.1 及以上电视的只读看板应用。

- 启动后直接打开 `tv.html`；
- 每 15 秒读取一次共享后端；
- 保持屏幕常亮、横屏和沉浸式全屏；
- 断网后每 15 秒自动重试；
- 遥控器返回键或菜单键用于手动刷新；
- 支持普通 Android Launcher 和 Android TV Leanback Launcher。

构建要求：JDK 17、Android SDK 35、Gradle 8.9。运行 `gradle assembleDebug`
或使用仓库中的 Gradle Wrapper 构建。
