# WF OpenClaw Adapter SystemD 配置手册


## 一、文件说明

本文档用于为 `openclaw-adapter-1.0.0.jar` Java 程序配置 SystemD 服务，实现服务的开机自启、手动启停、状态查看、日志排查等功能。

服务名称统一为：`wf-openclaw-adapter`

## 二、前置条件

1. 服务器已安装 Java 17环境：

    ```Bash
    
    java -version
    ```

    若未安装请自行安装java 17。

2. 把`openclaw-adapter-1.0.0.jar` 包放到`/opt/openclaw/`目录下（放置后的路径为：`/opt/openclaw/openclaw-adapter-1.0.0.jar`，也可以自行修改路径，如果修改路径请把`wf-openclaw-adapter.service`文件里的路径同步修改）。

## 三、服务文件内容

### 1. 文件放置目录

把 `wf-openclaw-adapter.service` 文件放置到 SystemD 服务默认目录：

```Bash
sudo cp wf-openclaw-adapter.service /etc/systemd/system/
```

## 四、核心操作命令

### 1. 重载 SystemD 配置（修改服务文件后必须执行）

```Bash

sudo systemctl daemon-reload
```

### 1. 启动服务
`sudo systemctl start wf-openclaw-adapter`

### 2.设置开机自启 
`sudo systemctl enable wf-openclaw-adapter`

### 3. 其他常用命令

|操作目的|执行命令|
|---|---|
|设置开机自启|`sudo systemctl enable wf-openclaw-adapter`|
|关闭开机自启|`sudo systemctl disable wf-openclaw-adapter`|
|启动服务|`sudo systemctl start wf-openclaw-adapter`|
|停止服务|`sudo systemctl stop wf-openclaw-adapter`|
|重启服务|`sudo systemctl restart wf-openclaw-adapter`|
|查看服务运行状态|`sudo systemctl status wf-openclaw-adapter`|

### 4. 日志查看（排错必备）

|日志需求|执行命令|
|---|---|
|实时查看日志|`sudo journalctl -u wf-openclaw-adapter -f`|
|查看最近100行日志|`sudo journalctl -u wf-openclaw-adapter -n 100`|
|指定时间范围日志|`sudo journalctl -u wf-openclaw-adapter --since "2026-02-28 08:00" --until "2026-02-28 09:00"`|
|查看日志并显示时间戳|`sudo journalctl -u wf-openclaw-adapter -o short-iso -f`|

## 五、常见问题排查

1. **服务启动失败**：

    - 优先执行 `sudo systemctl status wf-openclaw-adapter` 查看状态提示；

    - 检查 `ExecStart` 中 Java 路径（`which java` 确认）和 jar 包路径是否正确；

    - 检查端口是否被占用（`netstat -tulpn | grep java`）。

2. **日志无输出/文件读写失败**：

    - 确保 jar 包中所有文件路径使用绝对路径（无工作目录时默认根目录 `/`）；

    - 以 root 运行时默认权限充足，无需额外授权。

## 六、使用建议

1. 生产环境中，建议创建专用低权限用户（如 `claw`）运行服务，降低权限风险，请修改`wf-openclaw-adapter.service`文件：

    ```Bash
    
    # 创建用户
    sudo useradd -r -s /sbin/nologin claw
    # 修改服务文件，添加以下配置：
    # User=claw
    # Group=claw
    # 授权目录
    sudo chown -R claw:claw /opt/openclaw
    ```

2. 若需调整 JVM 参数（如内存），直接修改 `ExecStart` 中的 Java 命令即可；

3. 服务配置修改后，必须执行 `systemctl daemon-reload` 再重启服务才会生效。