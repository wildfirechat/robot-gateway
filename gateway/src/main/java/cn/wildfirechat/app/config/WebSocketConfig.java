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
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

/**
 * WebSocket配置类
 * 支持独立端口：HTTP使用server.port，WebSocket使用websocket.port
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final RobotGatewayEndpoint robotGatewayEndpoint;

    @Value("${websocket.port:8884}")
    private int websocketPort;

    public WebSocketConfig(RobotGatewayEndpoint robotGatewayEndpoint) {
        this.robotGatewayEndpoint = robotGatewayEndpoint;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(robotGatewayEndpoint, "/robot/gateway")
                .setAllowedOrigins("*");
    }

    /**
     * 配置额外的Tomcat连接器用于WebSocket
     */
    @Bean
    public WebServerFactoryCustomizer<TomcatServletWebServerFactory> tomcatCustomizer() {
        return factory -> {
            Connector connector = new Connector(TomcatServletWebServerFactory.DEFAULT_PROTOCOL);
            connector.setPort(websocketPort);
            factory.addAdditionalTomcatConnectors(connector);
        };
    }

    // 最大文本消息大小：60KB
    private static final int MAX_TEXT_MESSAGE_SIZE = 60 * 1024;
    // 最大二进制消息大小：60KB（当前不使用二进制消息）
    private static final int MAX_BINARY_MESSAGE_SIZE = 60 * 1024;

    /**
     * 配置WebSocket容器缓冲区大小
     */
    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(MAX_TEXT_MESSAGE_SIZE);
        container.setMaxBinaryMessageBufferSize(MAX_BINARY_MESSAGE_SIZE);
        //超时设置为450秒，7.5分钟
        container.setMaxSessionIdleTimeout(450000L);
        return container;
    }
}
