package cn.wildfirechat.moltbot.controller;

import cn.wildfirechat.moltbot.core.MoltbotBridge;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
import java.util.Map;

/**
 * Moltbot适配器状态监控接口
 */
@RestController
@RequestMapping("/moltbot")
public class MoltbotHealthController {

    @Autowired
    private MoltbotBridge bridge;

    /**
     * 健康检查接口
     * GET /actuator/health 会自动调用这个
     */
    @GetMapping("/status")
    public Map<String, Object> getStatus() {
        Map<String, Object> status = new HashMap<>();

        Map<String, Object> wildfire = new HashMap<>();
        wildfire.put("connected", bridge.isWildfireConnected());
        wildfire.put("status", bridge.isWildfireConnected() ? "UP" : "DOWN");

        Map<String, Object> moltbot = new HashMap<>();
        moltbot.put("connected", bridge.isMoltbotConnected());
        moltbot.put("status", bridge.isMoltbotConnected() ? "UP" : "DOWN");

        status.put("wildfire", wildfire);
        status.put("moltbot", moltbot);
        status.put("bridge", bridge.isRunning() ? "RUNNING" : "STOPPED");

        return status;
    }

    /**
     * 测试接口
     * GET /moltbot/test
     */
    @GetMapping("/test")
    public Map<String, String> test() {
        Map<String, String> result = new HashMap<>();
        result.put("message", "Moltbot Adapter is running");
        result.put("wildfire", bridge.isWildfireConnected() ? "Connected" : "Disconnected");
        result.put("moltbot", bridge.isMoltbotConnected() ? "Connected" : "Disconnected");
        return result;
    }
}
