// 启动后不响应任何请求：用来验证连接超时。
process.stdin.resume();
setInterval(() => {}, 1000);
