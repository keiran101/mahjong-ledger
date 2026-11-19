/**
 * v1.10 房间规则设置验证：normalizeSettings 白名单 / resolveSettings 默认 / applySettings 生效
 * + store 层 settings 读写迁移 + 房间规则驱动的算分。
 * 运行：node --experimental-sqlite --experimental-strip-types scripts/verify-settings.ts
 * 使用独立临时库（MJ_DB 指向 os.tmpdir），不碰真实 data/mahjong.db。
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.MJ_DB = process.env.MJ_DB
  || join(tmpdir(), `mahjong-verify-settings-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`)

const assert = (await import('node:assert/strict')).default
const { RULES } = await import('../lib/rules.ts')
const { normalizeSettings, resolveSettings, applySettings, SWITCH_DEFS } = await import('../lib/settings.ts')
const store = await import('../lib/store.mjs')
const { scoreRound } = await import('../lib/score.ts')

type Seat = 'E' | 'S' | 'W' | 'N'

function show(name: string, ok: boolean, extra = '') {
  console.log(`  ${ok ? 'OK' : 'FAIL'}  ${name}${extra ? ` · ${extra}` : ''}`)
  if (!ok) process.exitCode = 1
}

console.log('\n【normalizeSettings 白名单校验】')

// 1. 合法值通过
const okPatch = normalizeSettings({ horseTimesMode: 'flat' })
assert.deepEqual(okPatch, { horseTimesMode: 'flat' })
show('合法值 flat 通过', okPatch.horseTimesMode === 'flat')

// 2. 非法值拒绝
assert.throws(() => normalizeSettings({ horseTimesMode: 'x2' }), /只支持/, '非法值抛错')
show('非法值 x2 拒绝', true)

// 3. 未知 key / 空值 / 非对象：全部忽略，返回空 patch
assert.deepEqual(normalizeSettings({ hack: 1 }), {})
assert.deepEqual(normalizeSettings({ horseTimesMode: '' }), {})
assert.deepEqual(normalizeSettings('garbage'), {})
assert.deepEqual(normalizeSettings(null), {})
show('未知 key / 空值 / 非对象全部忽略', true)

// 4. 未声明的开关一律不进结果（后续加开关只认 SWITCH_DEFS）
const defs = SWITCH_DEFS.map((d) => d.key)
assert.deepEqual(defs, ['horseTimesMode'])
show(`SWITCH_DEFS 当前开关：${defs.join(', ')}`, true)

console.log('\n【resolveSettings 默认值】')
// 5. 空 patch → 跟随 rules.ts 全局默认
const def = resolveSettings(null)
assert.equal(def.horseTimesMode, RULES.horse.timesMode)
show(`空 patch → 默认 ${def.horseTimesMode}（= rules.ts 默认）`, true)

// 6. patch 补全：已设置项保留
const full = resolveSettings({ horseTimesMode: 'geometric' } as never)
assert.equal(full.horseTimesMode, 'geometric')
show('已设置项保留 geometric', true)

console.log('\n【applySettings 算分生效】')
// 统一算例：清一色(4档) 有鬼 base=8，自马 2 张
const modeInput = {
  winner: 'E' as Seat, dealer: 'E' as Seat, pattern: '清一色', hasGhost: true,
  horses: ['5万', '9条'], // 都映射庄家本位 = 赢家自马
}

// 7. additive（默认）→ ×(1+2)=3 → 8×3=24/家，赢家收 3 份 = 72
const dAdd = scoreRound(modeInput, applySettings(RULES, resolveSettings(null)))
assert.equal(dAdd.horseMode, 'additive')
assert.equal(dAdd.zimoPerLoser, 24)
assert.equal(dAdd.perPlayer.E, 72)
assert.equal(dAdd.perPlayer.S, -24)
show('additive ×(1+N) → 每家付 24，赢家收 72', dAdd.perPlayer.E === 72, 'horseMode=additive')

// 8. geometric → ×4 → 32/家，赢家收 96
const dGeo = scoreRound(modeInput, applySettings(RULES, resolveSettings({ horseTimesMode: 'geometric' } as never)))
assert.equal(dGeo.horseMode, 'geometric')
assert.equal(dGeo.perPlayer.E, 96)
assert.equal(dGeo.perPlayer.S, -32)
show('geometric ×2ⁿ → 每家付 32，赢家收 96', dGeo.perPlayer.E === 96, 'horseMode=geometric')

// 9. flat → 胡分不乘 8/家 + 2 张自马其余三家各付 2 → 每家付 12，赢家收 8×3+2×2×3=36
const dFlat = scoreRound(modeInput, applySettings(RULES, resolveSettings({ horseTimesMode: 'flat' } as never)))
assert.equal(dFlat.horseMode, 'flat')
assert.equal(dFlat.perPlayer.E, 36)
assert.equal(dFlat.perPlayer.S, -12)
assert.equal(dFlat.horseLines.length, 2)
show('flat 独立马分 → 每家付 12，赢家收 36', dFlat.perPlayer.E === 36, 'horseLines=2 条')

// 10. 不变量：任一模式 0 张自马倍数 = 1，无马时三家算法同分
for (const mode of ['additive', 'geometric', 'flat'] as const) {
  const noHorse = { ...modeInput, horses: [] }
  const d = scoreRound(noHorse, applySettings(RULES, resolveSettings({ horseTimesMode: mode } as never)))
  assert.equal(d.selfHorseTimes, 1, `${mode} 无马 ×1`)
  assert.equal(d.perPlayer.E, 24, `${mode} 无马赢家收 24`)
  assert.equal(d.perPlayer.S, -8, `${mode} 无马各家付 8`)
}
show('不变量：0 张自马 ×1，三模式无马同分', true)

console.log('\n【store 层 settings 读写】')
// 11. 建房：默认设置随 rules.ts
const code = store.createRoom({ name: '规则开关验证' })
assert.equal(store.getRoomMeta(code).settings.horseTimesMode, 'additive')
show('新房默认 additive', true)

// 12. 改设置：落库 + 读回
const st = store.setRoomSettings(code, { horseTimesMode: 'flat' })
assert.equal(st.horseTimesMode, 'flat')
assert.equal(store.getRoomMeta(code).settings.horseTimesMode, 'flat')
show('setRoomSettings 落库读回 flat', true)

// 13. merge 语义：只传的项被覆盖，其余保留（当前只有一项，用全量读回验证）
store.setRoomSettings(code, { horseTimesMode: 'geometric' })
assert.equal(store.getRoomMeta(code).settings.horseTimesMode, 'geometric')
show('再次切换 geometric 生效', true)

// 14. 非法值在 store 层同样被拒
assert.throws(() => store.setRoomSettings(code, { horseTimesMode: 'bad' }), /只支持/)
show('store 层拒绝非法值', true)

// 15. settings 存进 rooms 列，老库迁移不炸（本库建表即带列；老库走 ALTER 分支）
const raw = store.getRoomMeta(code)
assert.ok(raw.settings && typeof raw.settings === 'object')
show('rooms.settings 迁移/读取正常', true)

// 16. 端到端：房间规则变了，scoreRound 走房间规则（复刻 server roomRules 的调用方式）
store.setRoomSettings(code, { horseTimesMode: 'geometric' })
const rules = applySettings(RULES, store.getRoomMeta(code).settings)
const dRoom = scoreRound({ ...modeInput, dealer: store.getRoomMeta(code).dealer as Seat }, rules)
assert.equal(dRoom.horseMode, 'geometric')
assert.equal(dRoom.perPlayer.E, 96)
show('端到端：房间 geometric → 赢家收 96', true)

console.log('\n【例S1-S4 算例】additive 24 / geometric 32 / flat 12（同为清一色有鬼+自马2张）')
console.log('\n全部通过 ✓')
