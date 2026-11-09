/**
 * 拍照认牌通道验证（不打真实 VLM）。
 * node --experimental-strip-types scripts/verify-vision.ts
 */
import assert from 'node:assert/strict'
import { detectPattern } from '../lib/pattern.ts'
import { relFromRotatedIndex, seatFromRel, normalizeTileName, TILES_34 } from '../lib/tiles.ts'
import { buildDraft, extractJson } from '../lib/vision.mjs'

function tiles(...a: string[]) { return a }

console.log('— 牌面归一化 —')
assert.equal(normalizeTileName('三万'), '3万')
assert.equal(normalizeTileName('红中'), '红中')
assert.equal(normalizeTileName('中'), '红中')
assert.equal(normalizeTileName('5索'), '5条')
assert.equal(normalizeTileName('白板'), '白板')
assert.equal(TILES_34.length, 34)

console.log('— 横牌位置 → 放杠人 —')
assert.equal(relFromRotatedIndex(3, 4), 'xia')
assert.equal(relFromRotatedIndex(0, 4), 'shang')
assert.equal(relFromRotatedIndex(1, 4), 'dui')
assert.equal(seatFromRel('xia', 'E'), 'S')
assert.equal(seatFromRel('dui', 'E'), 'W')
assert.equal(seatFromRel('shang', 'E'), 'N')
assert.equal(seatFromRel('xia', 'S'), 'W')

console.log('— 牌型判定 —')
{
  const r = detectPattern({
    hand: tiles('1万','2万','3万','4万','5万','6万','7万','8万','9万','1条','2条','3条','东风','东风'),
  })
  assert.equal(r.complete, true)
  assert.equal(r.pattern, '鸡胡')
}

{
  const r = detectPattern({
    hand: tiles('1万','1万','1万','2条','2条','2条','3筒','3筒','3筒','4万','4万','4万','东风','东风'),
  })
  assert.equal(r.complete, true)
  assert.ok(r.candidates.includes('碰碰胡'))
  assert.equal(r.pattern, '碰碰胡')
}

{
  const r = detectPattern({
    hand: tiles('1万','1万','1万','2万','2万','2万','3万','3万','3万','4万','5万','6万','7万','7万'),
  })
  assert.equal(r.complete, true)
  assert.ok(r.candidates.includes('清一色'))
  assert.equal(r.pattern, '清一色')
}

{
  const r = detectPattern({
    hand: tiles('1万','1万','2万','2万','3条','3条','4条','4条','5筒','5筒','6筒','6筒','东风','东风'),
  })
  assert.equal(r.pattern, '七对')
}

{
  const r = detectPattern({
    hand: tiles('1万','1万','1万','1万','2万','2万','3条','3条','4条','4条','5筒','5筒','东风','东风'),
  })
  assert.equal(r.pattern, '豪华七对')
}

{
  const r = detectPattern({
    hand: tiles('1万','9万','1条','9条','1筒','9筒','东风','南风','西风','北风','红中','发财','白板','1万'),
  })
  assert.equal(r.pattern, '十三幺')
}

{
  const r = detectPattern({
    hand: tiles('1万','1万','1万','2万','3万','4万','5万','6万','7万','8万','9万','9万','9万','5万'),
  })
  assert.equal(r.pattern, '九宝莲灯')
}

{
  const r = detectPattern({
    hand: tiles('东风','东风','南风','南风','南风','西风','西风','西风','北风','北风','北风','红中','红中','红中'),
  })
  assert.equal(r.complete, true)
  assert.ok(r.candidates.includes('字一色'))
  assert.equal(r.pattern, '字一色')
}

{
  const r = detectPattern({
    hand: tiles('1万','1万','1万','2万','2万'),
    melds: [
      { kind: 'an', tiles: ['红中','红中','红中','红中'] },
      { kind: 'an', tiles: ['发财','发财','发财','发财'] },
      { kind: 'an', tiles: ['白板','白板','白板','白板'] },
    ],
  })
  assert.ok(r.candidates.includes('大三元'), r.candidates.join(','))
}

{
  // 有鬼：5条当百搭，补清一色（不是九莲）
  const r = detectPattern({
    hand: tiles('1万','1万','1万','2万','2万','2万','3万','3万','3万','4万','5万','6万','7万','5条'),
    ghostTile: '5条',
  })
  assert.equal(r.hasGhostInHand, true)
  assert.ok(r.candidates.includes('清一色'), r.candidates.join(','))
  assert.equal(r.pattern, '清一色')
}

{
  const r = detectPattern({
    hand: tiles('1万','2万','3万','4万','5万','6万','7万','8万','9万','1条','2条','3条','东风','东风'),
    special: 'tian',
  })
  assert.equal(r.pattern, '天胡')
}

{
  const r = detectPattern({
    hand: tiles('1万','1万','1万','2万','2万','2万','3万','3万','3万','4万','5万','6万','7万','7万'),
    special: 'gangkai',
  })
  // 清一色 times=4 > 杠上开花 times=2
  assert.equal(r.pattern, '清一色')
}

console.log('— VLM JSON 收成草稿（不算分） —')
{
  const raw = extractJson(`规范化描述：马 6万；点杠 1万×3 + 1万横(最右)=下家；手牌清一色。
{"description":"上排马 6万。副露点杠一万四张最右横。下手牌万子。","winnerGuess":"E","hand":[{"tile":"2万","orient":"shu"},{"tile":"2万","orient":"shu"},{"tile":"3万","orient":"shu"},{"tile":"3万","orient":"shu"},{"tile":"4万","orient":"shu"},{"tile":"4万","orient":"shu"},{"tile":"5万","orient":"shu"},{"tile":"5万","orient":"shu"},{"tile":"6万","orient":"shu"},{"tile":"6万","orient":"shu"},{"tile":"7万","orient":"shu"}],"melds":[{"kind":"dian","stacked":false,"gangGuess":"dian","tiles":[{"tile":"1万","orient":"shu"},{"tile":"1万","orient":"shu"},{"tile":"1万","orient":"shu"},{"tile":"1万","orient":"heng"}]}],"horses":[{"tile":"6万","orient":"shu"},{"tile":"红中","orient":"shu"}],"ghostTile":null,"special":"none","uncertain":["第3张手牌可能是2万或8万"]}`)
  const d = buildDraft(raw, { dealer: 'E', photographer: 'E' })
  assert.equal(d.winner, 'E')
  assert.equal(d.melds.length, 1)
  assert.equal(d.melds[0].kind, 'dian')
  assert.equal(d.melds[0].from, 'S', '最右横 = 下家 = 南')
  assert.equal(d.horses[0], '6万')
  assert.equal(d.horses[1], '红中')
  assert.ok(d.confirmReasons.length >= 6)
  assert.ok(d.warnings.some((w) => /可能是2万/.test(w)))
  assert.equal(d.gangEvents[0].type, 'dian')
  assert.equal(d.gangEvents[0].from, 'S')
  assert.ok(!('perPlayer' in d))
  assert.ok(!('detail' in d))
}

{
  const raw = {
    description: '暗杠四张全竖',
    winnerGuess: 'W',
    hand: ['2万','3万','4万','5条','5条','5条','6筒','7筒','8筒','东风','东风'],
    melds: [{
      kind: 'an', stacked: false,
      tiles: ['9万','9万','9万','9万'],
    }],
    horses: [],
    uncertain: [],
  }
  const d = buildDraft(raw, { dealer: 'E', photographer: 'W' })
  assert.equal(d.melds[0].kind, 'an')
  assert.equal(d.gangEvents[0].type, 'an')
  assert.equal(d.gangEvents[0].by, 'W')
  assert.ok(!d.gangEvents[0].from)
}

{
  // 超 4 张同牌要进警告
  const d = buildDraft({
    hand: ['1万','1万','1万','1万','2万','2万','2万','2万','3万','3万','3万'],
    melds: [{ tiles: ['1万','1万','1万'] }],
    horses: ['1万'],
  }, { photographer: 'E' })
  assert.ok(d.warnings.some((w) => /1万/.test(w) && /出现了/.test(w)))
}

console.log('\n拍照认牌通道验证通过：归一化、横牌映射、牌型、草稿不含分数')
