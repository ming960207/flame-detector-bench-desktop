// 测试波形数据接收
import http from 'http';

function checkWaveform() {
  const req = http.get('http://127.0.0.1:3003/api/flame/devices', (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      try {
        const state = JSON.parse(data);
        console.log('=== 探测器状态 ===');
        console.log(`在线设备: ${state.onlineCount}/${state.units.length}`);
        console.log('');
        state.units.forEach((unit) => {
          console.log(`探测器 ${unit.index}:`);
          console.log(`  在线: ${unit.online ? '是' : '否'}`);
          console.log(`  发送模式: ${unit.sendMode}`);
          console.log(`  协议: ${unit.protocol}`);
          console.log(`  波形样本: ${unit.historySampleTotal || 0}`);
          console.log(`  探头数据: P1=${unit.probe1} P2=${unit.probe2} P3=${unit.probe3}`);
          console.log(`  最后更新: ${new Date(unit.lastUpdate).toLocaleTimeString()}`);
          if (unit.lastError) console.log(`  错误: ${unit.lastError}`);
          console.log('');
        });
      } catch (error) {
        console.error('解析失败:', error.message);
      }
    });
  });
  
  req.on('error', (error) => {
    console.error('连接失败:', error.message);
  });
  
  req.end();
}

// 每 2 秒检查一次
setInterval(checkWaveform, 2000);
checkWaveform();
