/**
 * PLC管理器
 * 管理多个PLC控制器实例，支持动态添加、删除、配置
 */

import { EventEmitter } from 'events';
import { PLCController } from './s7-controller.js';
import { PLCDeviceConfigLocal, config } from '../config.js';
import { IOState, PLCDeviceStatus } from '../types.js';

export class PLCManager extends EventEmitter {
  private controllers: Map<string, PLCController> = new Map();
  private configs: Map<string, PLCDeviceConfigLocal> = new Map();

  async initializeAll(plcConfigs: PLCDeviceConfigLocal[]): Promise<void> {
    console.log(`[PLCManager] 初始化 ${plcConfigs.length} 个PLC设备...`);
    for (const cfg of plcConfigs) {
      if (cfg.enabled) {
        await this.addPLC(cfg);
      } else {
        this.configs.set(cfg.id, cfg);
        console.log(`[PLCManager] PLC ${cfg.name} (${cfg.id}) 已禁用，跳过连接`);
      }
    }
  }

  async addPLC(cfg: PLCDeviceConfigLocal): Promise<boolean> {
    if (this.controllers.has(cfg.id)) {
      await this.removePLC(cfg.id);
    }
    this.configs.set(cfg.id, cfg);
    if (!cfg.enabled) return false;

    const controller = new PLCController(cfg);

    controller.on('connected', () => {
      this.emit('relay:connected', cfg.id);
      this.emit('status:changed');
    });
    controller.on('disconnected', () => {
      this.emit('relay:disconnected', cfg.id);
      this.emit('status:changed');
    });
    controller.on('error', (err: string) => {
      this.emit('relay:error', cfg.id, err);
    });
    controller.on('data', (state: IOState) => {
      this.emit('relay:data', state);
    });

    this.controllers.set(cfg.id, controller);
    await controller.connect();
    return true;
  }

  async removePLC(id: string): Promise<void> {
    const ctrl = this.controllers.get(id);
    if (ctrl) {
      await ctrl.disconnect();
      this.controllers.delete(id);
    }
    this.configs.delete(id);
  }

  private applyRelations(channel: number, value: boolean, currentDoState: boolean[]): { channel: number; value: boolean }[] {
    const relations = config.doRelations;
    if (!relations) {
      return [{ channel, value }];
    }

    const commandMap = new Map<number, boolean>();
    commandMap.set(channel, value);

    // 1. 互斥处理 (Interlocks)
    if (value === true) {
      const interlocks = relations.interlocks || [];
      for (const group of interlocks) {
        if (group.includes(channel)) {
          for (const other of group) {
            if (other !== channel) {
              const currentVal = commandMap.has(other) ? commandMap.get(other) : currentDoState[other - 1];
              if (currentVal) {
                commandMap.set(other, false);
              }
            }
          }
        }
      }
    }

    // 2. 强关联处理 (Associations)
    const associations = relations.associations || [];
    const processAssociation = (srcCh: number, val: boolean) => {
      for (const assoc of associations) {
        if (assoc.source === srcCh) {
          for (const target of assoc.targets) {
            if (!commandMap.has(target) || commandMap.get(target) !== val) {
              commandMap.set(target, val);
              processAssociation(target, val);
            }
          }
        }
      }
    };
    processAssociation(channel, value);

    // 3. 联动处理 (Linkages)
    const linkages = relations.linkages || [];
    const processLinkage = (srcCh: number, val: boolean) => {
      for (const link of linkages) {
        if (link.source === srcCh) {
          const isTriggered = 
            (link.trigger === 'ON' && val === true) || 
            (link.trigger === 'OFF' && val === false);
          
          if (isTriggered) {
            let nextVal = false;
            if (link.action === 'ON') nextVal = true;
            else if (link.action === 'OFF') nextVal = false;
            else if (link.action === 'TOGGLE') {
              const current = commandMap.has(link.target) ? commandMap.get(link.target) : currentDoState[link.target - 1];
              nextVal = !current;
            }

            if (!commandMap.has(link.target) || commandMap.get(link.target) !== nextVal) {
              commandMap.set(link.target, nextVal);
              processAssociation(link.target, nextVal);
              processLinkage(link.target, nextVal);
            }
          }
        }
      }
    };
    processLinkage(channel, value);

    return Array.from(commandMap.entries()).map(([ch, val]) => ({ channel: ch, value: val }));
  }

  async writeDO(relayId: string, channel: number, value: boolean): Promise<void> {
    const ctrl = this.controllers.get(relayId);
    if (!ctrl) throw new Error(`PLC ${relayId} 不存在`);
    
    // 获取当前物理DO状态，默认为 12 个 false
    const currentState = ctrl.getCurrentState()?.do || new Array(12).fill(false);
    const commands = this.applyRelations(channel, value, currentState);
    console.log(`[PLCManager] 拦截 writeDO ch=${channel} val=${value}，转换命令流:`, JSON.stringify(commands));
    
    await ctrl.writeDOMulti(commands);
  }

  async writeDOMulti(relayId: string, channels: { channel: number; value: boolean }[]): Promise<void> {
    const ctrl = this.controllers.get(relayId);
    if (!ctrl) throw new Error(`PLC ${relayId} 不存在`);
    await ctrl.writeDOMulti(channels);
  }

  async writeAllDO(relayId: string, values: boolean[]): Promise<void> {
    const ctrl = this.controllers.get(relayId);
    if (!ctrl) throw new Error(`PLC ${relayId} 不存在`);
    await ctrl.writeAllDO(values);
  }

  async setOnlyOneDO(relayId: string, channel: number): Promise<void> {
    const ctrl = this.controllers.get(relayId);
    if (!ctrl) throw new Error(`PLC ${relayId} 不存在`);
    await ctrl.setOnlyOneDO(channel);
  }

  async disconnectAllDO(relayId: string): Promise<void> {
    const ctrl = this.controllers.get(relayId);
    if (!ctrl) throw new Error(`PLC ${relayId} 不存在`);
    await ctrl.disconnectAllDO();
  }

  getController(id: string): PLCController | undefined {
    return this.controllers.get(id);
  }

  getAllCurrentStates(): IOState[] {
    return Array.from(this.controllers.values()).map(c => c.getCurrentState());
  }

  getAllStatus(): PLCDeviceStatus[] {
    return Array.from(this.controllers.values()).map(c => c.getStatus());
  }

  async disconnectAll(): Promise<void> {
    for (const ctrl of this.controllers.values()) {
      await ctrl.disconnect();
    }
    this.controllers.clear();
  }
}

// 导出别名以兼容旧引用
export { PLCManager as RelayManager };
