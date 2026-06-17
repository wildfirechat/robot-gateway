package cn.wildfirechat.demo;

import cn.wildfirechat.client.RobotServiceClient;
import cn.wildfirechat.client.handler.MessageHandler;
import cn.wildfirechat.client.protocol.PushMessage;
import cn.wildfirechat.pojos.*;
import cn.wildfirechat.pojos.mesh.PojoSearchUserReq;
import cn.wildfirechat.pojos.mesh.PojoSearchUserRes;
import cn.wildfirechat.sdk.model.IMResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.util.Scanner;

/**
 * 机器人客户端Demo
 * 演示如何使用Robot Client连接网关并调用机器人API
 */
public class RobotClientDemo {

    private static final Logger LOG = LoggerFactory.getLogger(RobotClientDemo.class);

    private static RobotServiceClient robotClient;

    public static void main(String[] args) {
        String gatewayUrl = "ws://43.143.148.156:8884/robot/gateway";
        String robotId = "robot_nl0qmws2k_1770036437732";
        String robotSecret = "aa10e3cdda25401f8b3c956f8c607b85";

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

                case "upload":
                    if (parts.length < 2) {
                        LOG.warn("用法: upload <文件路径>");
                    } else {
                        uploadFileDemo(parts[1]);
                    }
                    break;

                case "friendlist":
                    getOwnerFriendListDemo();
                    break;

                case "search":
                    if (parts.length < 2) {
                        LOG.warn("用法: search <关键词>");
                    } else {
                        searchUserDemo(parts[1]);
                    }
                    break;

                case "robots":
                    if (parts.length < 2) {
                        LOG.warn("用法: robots <用户ID>");
                    } else {
                        getUserRobotsDemo(parts[1]);
                    }
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
        LOG.info("  friendlist                   - 获取机器人owner好友列表");
        LOG.info("  search <关键词>              - 根据昵称搜索用户");
        LOG.info("  robots <用户ID>              - 获取指定用户的机器人列表");
        LOG.info("  upload <文件路径>           - 上传文件");
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

    /**
     * 获取机器人owner好友列表Demo
     */
    private static void getOwnerFriendListDemo() {
        LOG.info("获取机器人owner好友列表");

        try {
            IMResult<OutputGetFriendList> result = robotClient.getOwnerFriendList();

            if (result.getCode() == 0) {
                OutputGetFriendList friendList = result.getResult();
                LOG.info("好友数量: {}", friendList.getFriends() != null ? friendList.getFriends().size() : 0);
                if (friendList.getFriends() != null && !friendList.getFriends().isEmpty()) {
                    LOG.info("好友列表: {}", String.join(", ", friendList.getFriends()));
                }
            } else {
                LOG.error("获取失败: [{}] {}", result.getCode(), result.getMsg());
            }
        } catch (Exception e) {
            LOG.error("获取好友列表异常: {}", e.getMessage(), e);
        }
    }

    /**
     * 根据昵称搜索用户Demo
     */
    private static void searchUserDemo(String keyword) {
        LOG.info("搜索用户: {}", keyword);

        try {
            IMResult<PojoSearchUserRes> result = robotClient.searchUserByDisplayName(keyword);

            if (result.getCode() == 0) {
                PojoSearchUserRes searchRes = result.getResult();
                int count = searchRes.getUserInfos() != null ? searchRes.getUserInfos().size() : 0;
                LOG.info("搜索到 {} 个用户", count);
                if (searchRes.getUserInfos() != null) {
                    for (InputOutputUserInfo userInfo : searchRes.getUserInfos()) {
                        LOG.info("  用户ID: {}, 昵称: {}", userInfo.getUserId(), userInfo.getDisplayName());
                    }
                }
            } else {
                LOG.error("搜索失败: [{}] {}", result.getCode(), result.getMsg());
            }
        } catch (Exception e) {
            LOG.error("搜索用户异常: {}", e.getMessage(), e);
        }
    }

    /**
     * 获取指定用户的机器人列表Demo
     */
    private static void getUserRobotsDemo(String userId) {
        LOG.info("获取用户 {} 的机器人列表", userId);

        try {
            IMResult<OutputGetRobotList> result = robotClient.getUserRobots(userId);

            if (result.getCode() == 0) {
                OutputGetRobotList robotList = result.getResult();
                int count = robotList.robotInfoList != null ? robotList.robotInfoList.size() : 0;
                LOG.info("找到 {} 个机器人", count);
                if (robotList.robotInfoList != null) {
                    for (OutputRobot robot : robotList.robotInfoList) {
                        LOG.info("  机器人ID: {}, 昵称: {}", robot.getUserId(), robot.getDisplayName());
                    }
                }
            } else {
                LOG.error("获取失败: [{}] {}", result.getCode(), result.getMsg());
            }
        } catch (Exception e) {
            LOG.error("获取机器人列表异常: {}", e.getMessage(), e);
        }
    }

    /**
     * 上传文件Demo
     */
    private static void uploadFileDemo(String filePath) {
        LOG.info("上传文件: {}", filePath);

        File file = new File(filePath);
        if (!file.exists()) {
            LOG.error("文件不存在: {}", filePath);
            return;
        }

        if (!file.isFile()) {
            LOG.error("路径不是文件: {}", filePath);
            return;
        }

        LOG.info("文件大小: {} bytes", file.length());

        try {
            IMResult<String> result = robotClient.uploadFile(file);

            if (result.getCode() == 0) {
                LOG.info("上传成功!");
                LOG.info("文件URL: {}", result.getResult());
            } else {
                LOG.error("上传失败: [{}] {}", result.getCode(), result.getMsg());
            }
        } catch (Exception e) {
            LOG.error("上传文件异常: {}", e.getMessage(), e);
        }
    }
}
