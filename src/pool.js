// 对象池与确定性随机：所有实体都从池里取，热循环里不做新分配（避免 GC 抖动）。

// 确定性随机，方便复现同一局
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pool(size, make) {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) arr[i] = make();
  return arr;
}

export function alloc(list) {
  for (let i = 0; i < list.length; i++) if (!list[i].active) return list[i];
  return null; // 池满就丢弃，宁可少生成也不扩容
}
