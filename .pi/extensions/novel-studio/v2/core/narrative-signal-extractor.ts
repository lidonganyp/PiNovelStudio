/**
 * NarrativeSignalExtractor - span-oriented evidence helpers for diagnostics.
 *
 * These helpers locate possible action, perception, and ending signals. They
 * do not score prose, reject candidates, prescribe rewrites, or select winners.
 */

export const AGENCY_ACTION_PATTERN =
  /推开|冲进|夺过|抓住|拿起|拿到|打开|关上|踢开|撞开|按下|锁住|切断|转身|决定|选择|拒绝|纵身|跳进|跳入|跳下|跳上|扑向|扑过|刺入|刺中|挥出|挥手|砸下|砸开|砸向|挡住|护住|护在|揽住|揽入|扣住|扣紧|探手|探身|扛起|扛上|塞进|塞入|跃起|跃过|摔下|摔向|劈|捞|踩|拽|拦|递/g;

export const PERCEPTION_LANGUAGE_PATTERN = /感到|意识到|注意到|突然明白/g;

const ENDING_SIGNAL_PATTERN =
  /？|为什么|什么|谁|怎么|哪里|难道|难不成|发现|意识到|注意到|突然|却看到|却听到|才意识到|决定|选择|转身|走向|拿出|按下|原来|竟然|居然|不对|有问题|不对劲/;

export function extractAgencyActions(text: string): string[] {
  return text ? Array.from(new Set(text.match(AGENCY_ACTION_PATTERN) ?? [])) : [];
}

export function extractPerceptionMarkers(text: string): string[] {
  return text ? Array.from(new Set(text.match(PERCEPTION_LANGUAGE_PATTERN) ?? [])) : [];
}

export function extractEndingRegion(text: string): string {
  return text ? text.replace(/\s+$/, "").slice(-600) : "";
}

export function hasWebnovelHookSignal(text: string): boolean {
  return Boolean(text && ENDING_SIGNAL_PATTERN.test(text));
}
