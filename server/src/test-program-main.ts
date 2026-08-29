import { startTestProgramServer } from './test-program/test-program-server.js';

const runtime = await startTestProgramServer();

const shutdown = async (signal: string) => {
  console.log(`[测试观察器] 收到 ${signal}，正在停止`);
  await runtime.close();
  process.exit(0);
};

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
