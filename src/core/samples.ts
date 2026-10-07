import type { OscNode } from './types.js';

/** 规格已知向量：/x ,i 7 */
export const knownMessage: OscNode = {
  kind: 'message',
  address: '/x',
  args: [{ type: 'i', value: 7 }],
};

export const KNOWN_MESSAGE_HEX = '2f7800002c69000000000007';

/** 立即执行标签、单元素 bundle（32 字节） */
export const knownImmediateBundle: OscNode = {
  kind: 'bundle',
  timetag: '1',
  elements: [knownMessage],
};

/** 含中文字符串、零字节 blob、两层嵌套的综合样例 */
export const complexSample: OscNode = {
  kind: 'bundle',
  timetag: '12029300000000000000',
  elements: [
    {
      kind: 'message',
      address: '/hello/你好',
      args: [
        { type: 's', value: '世界' },
        { type: 'b', value: '' },
      ],
    },
    {
      kind: 'bundle',
      timetag: '1',
      elements: [
        {
          kind: 'bundle',
          timetag: '0',
          elements: [
            {
              kind: 'message',
              address: '/deep',
              args: [
                { type: 'f', value: 0.1 },
                { type: 'i', value: -12345 },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** float32 0.1 舍入样例 */
export const floatSample: OscNode = {
  kind: 'message',
  address: '/f',
  args: [{ type: 'f', value: 0.1 }],
};

/** 空 bundle（仅标记与时间标签，16 字节） */
export const emptyBundle: OscNode = {
  kind: 'bundle',
  timetag: '1',
  elements: [],
};
