package cn.wildfirechat.moltbot.config;

import cn.wildfirechat.moltbot.core.MoltbotBridge;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

/**
 * 健康检查指示器
 * 集成到Spring Boot Actuator
 */
@Component
public class MoltbotHealthIndicator implements HealthIndicator {

    @Autowired
    private MoltbotBridge bridge;

    @Override
    public Health health() {
        if (bridge.isRunning() && bridge.isWildfireConnected() && bridge.isMoltbotConnected()) {
            return Health.up()
                    .withDetail("wildfire", "connected")
                    .withDetail("moltbot", "connected")
                    .withDetail("bridge", "running")
                    .build();
        } else {
            return Health.down()
                    .withDetail("wildfire", bridge.isWildfireConnected() ? "connected" : "disconnected")
                    .withDetail("moltbot", bridge.isMoltbotConnected() ? "connected" : "disconnected")
                    .withDetail("bridge", bridge.isRunning() ? "running" : "stopped")
                    .build();
        }
    }
}
