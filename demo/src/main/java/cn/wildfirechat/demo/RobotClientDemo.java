package cn.wildfirechat.demo;

import cn.wildfirechat.client.RobotServiceClient;
import cn.wildfirechat.client.handler.MessageHandler;
import cn.wildfirechat.client.protocol.PushMessage;
import cn.wildfirechat.pojos.*;
import cn.wildfirechat.sdk.model.IMResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Scanner;

/**
 * 机器人客户端Demo
 * 演示如何使用Robot Client连接网关并调用机器人API
 */
public class RobotClientDemo {

    private static final Logger LOG = LoggerFactory.getLogger(RobotClientDemo.class);

    private static RobotServiceClient robotClient;

    public static void main(String[] args) {
        String gatewayUrl = "ws://localhost:8884/robot/gateway";
        String robotId = "FireRobot";
        String robotSecret = "123456";

        if (args.length >= 3) {
            gatewayUrl = args[0];
            robotId = args[1];
            robotSecret = args[2];
        }

        LOG.info("========================================");
        LOG.info("野火IM机器人客户端Demo");
        LOG.info("========================================");
        LOG.info("网关地址: {}", gatewayUrl);
        LOG.info("机器人ID: {}", robotId);
        LOG.info("========================================");

        // 创建消息处理器
        MessageHandler messageHandler = new MessageHandler() {
            @Override
            public void onMessage(PushMessage message) {
                LOG.info("收到消息推送:");
                LOG.info("  类型: {}", message.getType());
                if (message.getData() != null) {
                    LOG.info("  发送者: {}", message.getData().getSender());
                    LOG.info("  消息ID: {}", message.getData().getMessageId());
                    LOG.info("  会话: {}", message.getData().getConv());
                    LOG.info("  内容: {}", message.getData().getPayload());
                }
            }

            @Override
            public void onConnectionChanged(boolean connected) {
                if (connected) {
                    LOG.info("连接已建立并鉴权成功");
                } else {
                    LOG.warn("连接已断开");
                }
            }

            @Override
            public void onError(String error) {
                LOG.error("发生错误: {}", error);
            }
        };

        // 创建机器人客户端
        robotClient = new RobotServiceClient(gatewayUrl, messageHandler);

        // 连接并鉴权
        LOG.info("正在连接网关...");
        boolean success = robotClient.connect(robotId, robotSecret);

        if (!success) {
            LOG.error("鉴权失败，请检查机器人ID和密钥是否正确");
            System.exit(1);
        }

        // 启动交互式命令行
        startInteractiveMode();

        // 关闭连接
        LOG.info("正在关闭连接...");
        robotClient.close();
        LOG.info("Demo结束");
    }

    /**
     * 交互式命令行模式
     */
    private static void startInteractiveMode() {
        Scanner scanner = new Scanner(System.in);
        boolean running = true;

        LOG.info("");
        LOG.info("========================================");
        LOG.info("输入命令进行操作（输入 help 查看帮助）:");
        LOG.info("========================================");

        while (running) {
            System.out.print("> ");
            String input = scanner.nextLine().trim();

            if (input.isEmpty()) {
                continue;
            }

            String[] parts = input.split("\\s+", 3);
            String command = parts[0].toLowerCase();

            switch (command) {
                case "help":
                    printHelp();
                    break;

                case "send":
                    if (parts.length < 3) {
                        LOG.warn("用法: send <用户ID> <消息内容>");
                    } else {
                        sendMessageDemo(parts[1], parts[2]);
                    }
                    break;

                case "info":
                    if (parts.length < 2) {
                        LOG.warn("用法: info <用户ID>");
                    } else {
                        getUserInfoDemo(parts[1]);
                    }
                    break;

                case "group":
                    createGroupDemo();
                    break;

                case "profile":
                    getProfileDemo();
                    break;

                case "status":
                    printStatus();
                    break;

                case "quit":
                case "exit":
                    running = false;
                    break;

                default:
                    LOG.warn("未知命令: {}，输入 help 查看帮助", command);
                    break;
            }
        }

        scanner.close();
    }

    /**
     * 打印帮助信息
     */
    private static void printHelp() {
        LOG.info("========================================");
        LOG.info("可用命令:");
        LOG.info("========================================");
        LOG.info("  send <用户ID> <消息内容>    - 发送单聊消息");
        LOG.info("  info <用户ID>               - 获取用户信息");
        LOG.info("  group                        - 创建群组");
        LOG.info("  profile                      - 获取机器人资料");
        LOG.info("  status                       - 查看连接状态");
        LOG.info("  help                         - 显示帮助");
        LOG.info("  quit/exit                    - 退出程序");
        LOG.info("========================================");
    }

    /**
     * 发送消息Demo
     */
    private static void sendMessageDemo(String targetId, String text) {
        LOG.info("发送消息到 {}: {}", targetId, text);

        try {
            Conversation conv = new Conversation();
            conv.setType(0); // 单聊
            conv.setTarget(targetId);

            MessagePayload payload = new MessagePayload();
            payload.setType(1); // 文本消息
            payload.setContent(text);
            payload.setSearchableContent(text);

            IMResult<SendMessageResult> result = robotClient.sendMessage(conv, payload);

            if (result.getCode() == 0) {
                LOG.info("发送成功，消息ID: {}", result.getResult().getMessageUid());
            } else {
                LOG.error("发送失败: [{}] {}", result.getCode(), result.getMsg());
            }
        } catch (Exception e) {
            LOG.error("发送消息异常: {}", e.getMessage(), e);
        }
    }

    /**
     * 获取用户信息Demo
     */
    private static void getUserInfoDemo(String userId) {
        LOG.info("获取用户信息: {}", userId);

        try {
            IMResult<InputOutputUserInfo> result =
                    robotClient.getUserInfo(userId);

            if (result.getCode() == 0) {
                InputOutputUserInfo userInfo = result.getResult();
                LOG.info("用户信息:");
                LOG.info("  用户ID: {}", userInfo.getUserId());
                LOG.info("  昵称: {}", userInfo.getDisplayName());
            } else {
                LOG.error("获取失败: [{}] {}", result.getCode(), result.getMsg());
            }
        } catch (Exception e) {
            LOG.error("获取用户信息异常: {}", e.getMessage(), e);
        }
    }

    /**
     * 创建群组Demo
     */
    private static void createGroupDemo() {
        LOG.info("创建群组Demo（简化版本）");

        try {
            PojoGroupInfo groupInfo = new PojoGroupInfo();
            groupInfo.setName("测试群组");
            groupInfo.setType(0); // 普通群

            // 注意：createGroup现在需要5个参数
            IMResult<OutputCreateGroupResult> result =
                robotClient.createGroup(groupInfo, null, null, null, null);

            if (result.getCode() == 0) {
                LOG.info("创建群组成功");
            } else {
                LOG.error("创建群组失败: [{}] {}", result.getCode(), result.getMsg());
            }
        } catch (Exception e) {
            LOG.error("创建群组异常: {}", e.getMessage(), e);
        }
    }

    /**
     * 获取机器人资料Demo
     */
    private static void getProfileDemo() {
        LOG.info("获取机器人资料");

        try {
            IMResult<OutputRobot> result = robotClient.getProfile();

            if (result.getCode() == 0) {
                OutputRobot profile = result.getResult();
                LOG.info("机器人资料:");
                LOG.info("  ID: {}", profile.getUserId());
                LOG.info("  昵称: {}", profile.getDisplayName());
            } else {
                LOG.error("获取资料失败: [{}] {}", result.getCode(), result.getMsg());
            }
        } catch (Exception e) {
            LOG.error("获取机器人资料异常: {}", e.getMessage(), e);
        }
    }

    /**
     * 打印连接状态
     */
    private static void printStatus() {
        LOG.info("========================================");
        LOG.info("连接状态:");
        LOG.info("  是否运行: {}", robotClient.isRunning());
        LOG.info("  是否连接: {}", robotClient.isConnected());
        LOG.info("  是否鉴权: {}", robotClient.isAuthenticated());
        LOG.info("========================================");
    }
}
