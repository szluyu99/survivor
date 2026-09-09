// 对象池与确定性随机：所有实体都从池里取，热循环里不做新分配（避免 GC 抖动）。

// 确定性随机。仍然是可直接调用的函数（`w.rng()`），但额外挂了 getState/setState：
// 存档和回放要能把随机数发生器的内部状态一起带走，否则"同一个 seed"只能从头复现
export function mulberry32(seed) {
  let a = seed >>> 0;
  const rng = function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.getState = () => a;
  rng.setState = (v) => { a = v >>> 0; };
  return rng;
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
