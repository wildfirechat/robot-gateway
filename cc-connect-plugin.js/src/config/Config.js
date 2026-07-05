import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_CONFIG = {
  wildfire: {
    gatewayUrl: 'ws://localhost:8884/robot/gateway',
    robotId: '',
    robotSecret: '',
  },
  ccconnect: {
    transport: 'websocket',
    url: 'ws://localhost:9810/bridge/ws',
    token: '',
    platform: 'wildfire',
    project: '',
    capabilities: ['text', 'image', 'file', 'audio', 'typing', 'update_message', 'preview', 'delete_message', 'reconstruct_reply'],
    reconnectInterval: 5000,
    heartbeatInterval: 30000,
  },
  filter: {
    whitelist: {
      enabled: true,
      allowedUsers: [],
      allowedGroups: [],
      deniedMessage: '未授权使用',
    },
    group: {
      enabled: true,
      requireMention: true,
      respondOnQuestion: true,
      helpKeywords: '帮,请,分析,总结,怎么,如何',
      allowedGroupIds: [],
    },
  },
  server: {
    port: 8090,
  },
};

/**
 * 配置管理器
 * 优先级：
 * 1. 命令行 -config 参数指定的文件
 * 2. ~/.cc-connect-plugin/config.json
 * 3. 环境变量
 * 4. 默认值
 */
export class Config {
  constructor(configPath = null) {
    this.config = this.loadConfig(configPath);
  }

  loadConfig(configPath) {
    let fileConfig = {};
    let filePath = configPath;

    if (!filePath) {
      const defaultPath = join(homedir(), '.cc-connect-plugin', 'config.json');
      if (existsSync(defaultPath)) {
        filePath = defaultPath;
      }
    } else {
      filePath = resolve(filePath);
    }

    if (filePath && existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        fileConfig = JSON.parse(content);
        console.log(`[config] loaded from ${filePath}`);
      } catch (error) {
        console.error(`[config] failed to load ${filePath}: ${error.message}`);
        process.exit(1);
      }
    } else if (configPath) {
      console.error(`[config] file not found: ${configPath}`);
      process.exit(1);
    } else {
      console.log('[config] no config file found, using defaults and environment variables');
    }

    const config = mergeDeep(DEFAULT_CONFIG, fileConfig);
    applyEnvironmentVariables(config);
    validateConfig(config);
    return config;
  }

  get() {
    return this.config;
  }

  getWildfireConfig() {
    return this.config.wildfire;
  }

  getCcConnectConfig() {
    return this.config.ccconnect;
  }

  getFilterConfig() {
    return this.config.filter;
  }

  getServerConfig() {
    return this.config.server;
  }

  static initConfigDir() {
    const configDir = join(homedir(), '.cc-connect-plugin');
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
      console.log(`[config] created directory ${configDir}`);
    }
    return configDir;
  }
}

function mergeDeep(target, source) {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    for (const key of Object.keys(source)) {
      if (isObject(source[key])) {
        if (!(key in target)) {
          output[key] = source[key];
        } else {
          output[key] = mergeDeep(target[key], source[key]);
        }
      } else {
        output[key] = source[key];
      }
    }
  }
  return output;
}

function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

function applyEnvironmentVariables(config) {
  if (process.env.WILDFIRE_GATEWAY_URL) config.wildfire.gatewayUrl = process.env.WILDFIRE_GATEWAY_URL;
  if (process.env.WILDFIRE_ROBOT_ID) config.wildfire.robotId = process.env.WILDFIRE_ROBOT_ID;
  if (process.env.WILDFIRE_ROBOT_SECRET) config.wildfire.robotSecret = process.env.WILDFIRE_ROBOT_SECRET;

  if (process.env.CCCONNECT_TRANSPORT) config.ccconnect.transport = process.env.CCCONNECT_TRANSPORT;
  if (process.env.CCCONNECT_URL) config.ccconnect.url = process.env.CCCONNECT_URL;
  if (process.env.CCCONNECT_TOKEN) config.ccconnect.token = process.env.CCCONNECT_TOKEN;
  if (process.env.CCCONNECT_PLATFORM) config.ccconnect.platform = process.env.CCCONNECT_PLATFORM;
  if (process.env.CCCONNECT_PROJECT) config.ccconnect.project = process.env.CCCONNECT_PROJECT;
  if (process.env.CCCONNECT_CAPABILITIES) {
    config.ccconnect.capabilities = process.env.CCCONNECT_CAPABILITIES.split(',').filter(Boolean);
  }
  if (process.env.CCCONNECT_RECONNECT_INTERVAL) {
    config.ccconnect.reconnectInterval = parseInt(process.env.CCCONNECT_RECONNECT_INTERVAL, 10);
  }
  if (process.env.CCCONNECT_HEARTBEAT_INTERVAL) {
    config.ccconnect.heartbeatInterval = parseInt(process.env.CCCONNECT_HEARTBEAT_INTERVAL, 10);
  }

  if (process.env.CCCONNECT_WHITELIST_ENABLED) {
    config.filter.whitelist.enabled = process.env.CCCONNECT_WHITELIST_ENABLED === 'true';
  }
  if (process.env.CCCONNECT_WHITELIST_USERS) {
    config.filter.whitelist.allowedUsers = process.env.CCCONNECT_WHITELIST_USERS.split(',').filter(Boolean);
  }
  if (process.env.CCCONNECT_WHITELIST_GROUPS) {
    config.filter.whitelist.allowedGroups = process.env.CCCONNECT_WHITELIST_GROUPS.split(',').filter(Boolean);
  }

  if (process.env.SERVER_PORT) {
    config.server.port = parseInt(process.env.SERVER_PORT, 10);
  }
}

function validateConfig(config) {
  const errors = [];

  if (!config.wildfire.gatewayUrl) errors.push('Missing wildfire.gatewayUrl');
  if (!config.wildfire.robotId) errors.push('Missing wildfire.robotId');
  if (!config.wildfire.robotSecret) errors.push('Missing wildfire.robotSecret');

  if (!config.ccconnect.url) errors.push('Missing ccconnect.url');

  if (errors.length > 0) {
    console.error('[config] validation errors:');
    errors.forEach((err) => console.error(`  - ${err}`));
    console.error('\nPlease provide config via:');
    console.error('  1. Config file: ~/.cc-connect-plugin/config.json or -config <path>');
    console.error('  2. Environment variables: WILDFIRE_ROBOT_ID, WILDFIRE_ROBOT_SECRET, CCCONNECT_URL');
    process.exit(1);
  }
}
