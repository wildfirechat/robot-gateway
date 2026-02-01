package cn.wildfirechat.app.config;

import cn.wildfirechat.app.gateway.RobotGatewayEndpoint;
import org.apache.catalina.connector.Connector;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * WebSocket配置类
 * 支持独立端口：HTTP使用8883，WebSocket使用8884
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final RobotGatewayEndpoint robotGatewayEndpoint;

    @Value("${server.port:8883}")
    private int httpPort;

    @Value("${websocket.port:8884}")
    private int websocketPort;

    public WebSocketConfig(RobotGatewayEndpoint robotGatewayEndpoint) {
        this.robotGatewayEndpoint = robotGatewayEndpoint;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        // 注册机器人网关WebSocket端点
        registry.addHandler(robotGatewayEndpoint, "/robot/gateway")
                .setAllowedOrigins("*"); // 允许所有来源，生产环境应限制
    }

    /**
     * 配置额外的Tomcat连接器用于WebSocket
     */
    @Bean
    public WebServerFactoryCustomizer<TomcatServletWebServerFactory> tomcatCustomizer() {
        return factory -> {
            // 添加WebSocket端口的连接器
            Connector connector = new Connector(TomcatServletWebServerFactory.DEFAULT_PROTOCOL);
            connector.setPort(websocketPort);
            factory.addAdditionalTomcatConnectors(connector);
        };
    }
}
