import { z } from "zod";
import { loadConfig as loadBaseConfig } from "../config/index.ts";
import type { Config as BaseConfig } from "../config/index.ts";

export const HemsConfigSchema = z.object({
  mqtt: z.object({
    broker: z.string().default("mqtt://localhost:1883"),
    user: z.string().default("hems"),
    password: z.string().default("hems_dev_mqtt"),
    topicPrefix: z.string().default("hems"),
  }).default({}),

  metrics: z.object({
    interval: z.number().int().positive().default(10),      // seconds
    processInterval: z.number().int().positive().default(30),
    cpuHighThreshold: z.number().min(0).max(100).default(90),
    memHighThreshold: z.number().min(0).max(100).default(90),
    gpuTempHighThreshold: z.number().positive().default(85),
    diskHighThreshold: z.number().min(0).max(100).default(90),
  }).default({}),

  gmail: z.object({
    enabled: z.boolean().default(false),
    email: z.string().default(""),
    appPassword: z.string().default(""),
    interval: z.number().int().positive().default(300),     // seconds
  }).default({}),

  github: z.object({
    enabled: z.boolean().default(false),
    token: z.string().default(""),
    interval: z.number().int().positive().default(300),
  }).default({}),

  homeAssistant: z.object({
    enabled: z.boolean().default(false),
    url: z.string().default("http://homeassistant.local:8123"),
    token: z.string().default(""),
  }).default({}),

  server: z.object({
    // Internal listen port. In Docker, map this to the host port via docker-compose.
    // Defaults to 8000 to match the existing openclaw-bridge container port.
    port: z.number().int().positive().default(8000),
    host: z.string().default("0.0.0.0"),
  }).default({}),
});

export type HemsConfig = z.infer<typeof HemsConfigSchema>;
export type FullConfig = BaseConfig & { hems: HemsConfig };

export function loadHemsConfig(): FullConfig {
  const base = loadBaseConfig();

  // Load HEMS-specific config from env vars (for Docker compatibility)
  const hemsRaw = {
    mqtt: {
      broker: process.env.MQTT_BROKER
        ? `mqtt://${process.env.MQTT_BROKER}`
        : undefined,
      user: process.env.MQTT_USER,
      password: process.env.MQTT_PASS,
    },
    metrics: {
      interval: process.env.OPENCLAW_METRICS_INTERVAL
        ? parseInt(process.env.OPENCLAW_METRICS_INTERVAL, 10)
        : undefined,
      processInterval: process.env.OPENCLAW_PROCESS_INTERVAL
        ? parseInt(process.env.OPENCLAW_PROCESS_INTERVAL, 10)
        : undefined,
    },
    gmail: {
      enabled: process.env.HEMS_GMAIL_ENABLED === "true",
      email: process.env.HEMS_GMAIL_EMAIL,
      appPassword: process.env.HEMS_GMAIL_APP_PASSWORD,
      interval: process.env.HEMS_GMAIL_INTERVAL
        ? parseInt(process.env.HEMS_GMAIL_INTERVAL, 10)
        : undefined,
    },
    github: {
      enabled: process.env.HEMS_GITHUB_ENABLED === "true",
      token: process.env.HEMS_GITHUB_TOKEN,
      interval: process.env.HEMS_GITHUB_INTERVAL
        ? parseInt(process.env.HEMS_GITHUB_INTERVAL, 10)
        : undefined,
    },
    homeAssistant: {
      enabled: !!process.env.HEMS_HA_URL,
      url: process.env.HEMS_HA_URL,
      token: process.env.HEMS_HA_TOKEN,
    },
    server: {
      // PORT env var controls the internal container listen port
      port: process.env.PORT
        ? parseInt(process.env.PORT, 10)
        : undefined,
    },
  };

  const hems = HemsConfigSchema.parse(hemsRaw);
  return { ...base, hems };
}
