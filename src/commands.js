// =====================================================================
// 슬래시 명령어 정의 + 처리
// ---------------------------------------------------------------------
// 명령어는 전역 등록(index.js)이라 봇이 들어간 모든 서버에서 보인다.
// 포인트·구간·알림은 모두 "명령을 쓴 서버" 것이다 (interaction.guildId).
//
//   /포인트 [유저]                         누구나 — 잔액 + 최근 기록 (본인만 보임)
//   /포인트추가·제거·지정 유저 숫자 [사유]   관리자 — 기록 → 역할·별명 반영 → 알림
//   /포인트역할 기능 [포인트] [역할~역할5]   관리자 — 구간 추가·제거·목록
//   /포인트알림 [채널] [끄기] [역할]         관리자 — 알림 채널·구간 돌파 때 멘션할 역할 1개 (채널 비우면 지금 채널, 끄기:True 면 끔)
//
// "관리자" = 서버 관리(Manage Server) 권한. 디스코드가 권한 없는 사람에겐 명령을 숨긴다.
// 디스코드와 직접 닿는 일(역할·별명 적용, 채널 전송)은 ctx 로 받아서 한다 → 테스트에서 가짜로 바꿀 수 있다.
// =====================================================================
const {
  SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, ChannelType, MessageFlags,
} = require('discord.js');
const points = require('./points');
const rules = require('./rules');
const settings = require('./settings');

// 관리자 명령에 필요한 권한
const ADMIN = PermissionFlagsBits.ManageGuild;
// 디스코드 명령 옵션 하나에는 역할을 하나만 넣을 수 있어서, 여러 개를 받으려고 칸을 5개 둔다
const ROLE_SLOTS = ['역할', '역할2', '역할3', '역할4', '역할5'];

// 명령에 역할 칸 5개를 붙인다 (전부 선택 사항)
const addRoleOptions = (b) => {
  for (const name of ROLE_SLOTS) b.addRoleOption((o) => o.setName(name).setDescription('역할 (여러 개면 역할2~5 도)'));
  return b;
};

// /포인트추가·제거·지정 은 옵션이 같아서 한 함수로 만든다. min = 숫자 최솟값(지정은 0 허용)
const recordCommand = (name, desc, min) => new SlashCommandBuilder().setName(name).setDescription(desc)
  .setDefaultMemberPermissions(ADMIN)
  .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
  .addIntegerOption((o) => o.setName('숫자').setDescription('포인트').setRequired(true).setMinValue(min))
  .addStringOption((o) => o.setName('사유').setDescription('기록용 메모').setMaxLength(200));

// 디스코드에 등록할 명령어 목록 (index.js 가 기동할 때 전역 등록)
const data = [
  new SlashCommandBuilder().setName('포인트').setDescription('포인트와 최근 기록을 봅니다')
    .addUserOption((o) => o.setName('유저').setDescription('다른 사람 보기')),
  recordCommand('포인트추가', '[관리자] 포인트 추가', 1),
  recordCommand('포인트제거', '[관리자] 포인트 제거', 1),
  recordCommand('포인트지정', '[관리자] 포인트를 이 값으로 지정', 0),
  addRoleOptions(new SlashCommandBuilder().setName('포인트역할').setDescription('[관리자] 포인트 구간별 자동 역할')
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption((o) => o.setName('기능').setDescription('추가 / 제거 / 목록').setRequired(true)
      .addChoices({ name: '추가', value: 'add' }, { name: '제거', value: 'remove' }, { name: '목록', value: 'list' }))
    .addStringOption((o) => o.setName('포인트').setDescription('0-100 (구간, 양 끝 포함) 또는 100 (그 이상)').setMaxLength(40))),
  new SlashCommandBuilder().setName('포인트알림').setDescription('[관리자] 알림 채널 설정 (채널을 비우면 지금 채널)')
    .setDefaultMemberPermissions(ADMIN)
    .addChannelOption((o) => o.setName('채널').setDescription('알림을 올릴 채널 (비우면 이 명령을 쓴 채널)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addBooleanOption((o) => o.setName('끄기').setDescription('True 면 알림을 끕니다'))
    .addRoleOption((o) => o.setName('역할').setDescription('구간을 넘었을 때 같이 멘션할 역할 (평소 기록은 유저만 멘션)')),
].map((b) => b.setContexts(InteractionContextType.Guild).toJSON()); // 서버에서만 (DM 에선 안 보임)

// 명령 이름 → points.record 의 mode
const MODE = { 포인트추가: 'add', 포인트제거: 'remove', 포인트지정: 'set' };

// 명령한 사람에게만 보이는 답장. 답장 안의 멘션으로 알림이 가지 않게 막는다.
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
// 역할 ID 들 → "<@&1>, <@&2>" (디스코드가 역할 이름으로 보여 준다)
const roleList = (ids) => ids.map((id) => `<@&${id}>`).join(', ');
// 수량 표시: 추가 "+100P", 제거 "-100P", 지정 "100P 로"
const amountText = (mode, amount) => (mode === 'add' ? `+${amount}P` : mode === 'remove' ? `-${amount}P` : `${amount}P 로`);

// 알림 채널에 올릴 기록 메시지.
//  - 기록마다: 해당 유저만 멘션한 📝 한 줄
//  - 구간을 넘으면(단계가 올라가면): 🎉 줄을 더 붙이고 /포인트알림 에서 고른 역할도 멘션
// allowedMentions 로 실제로 알림이 가는 대상을 이것만으로 제한한다(받은 구간 역할 이름은 알림 없이 표시만).
//   stageUp: { stage: 새 단계 번호, range: "200P 이상" } 또는 null
function recordNotice({ adminId, userId, mode, amount, note, before, after, added = [], stageUp = null, notifyRoleIds = [] }) {
  const lines = [`📝 <@${adminId}> → <@${userId}> 포인트 ${points.LABEL[mode]} ${amountText(mode, amount)} · ${before}P → **${after}P**${note ? ` (사유: ${note})` : ''}`];
  const pingRoles = stageUp ? notifyRoleIds : [];
  if (stageUp) {
    const ping = pingRoles.map((id) => `<@&${id}> `).join('');
    const got = added.length ? ` (받은 역할: ${roleList(added)})` : '';
    lines.push(`🎉 ${ping}<@${userId}> 님이 **${stageUp.stage}단계**(${stageUp.range})에 올라섰습니다!${got}`);
  }
  return {
    content: lines.join('\n'),
    allowedMentions: { users: [userId], roles: pingRoles },
  };
}

// 이번 기록으로 단계가 올라갔나 — 올라갔으면 { stage, range }, 아니면 null (내려가거나 그대로면 축하 안 함)
function stageUpOf(ruleList, before, after) {
  const from = rules.stageFor(ruleList, before);
  const to = rules.stageFor(ruleList, after);
  if (to <= from || to === 0) return null;
  const ordered = [...ruleList].sort((a, b) => a.min - b.min || (a.max ?? Infinity) - (b.max ?? Infinity));
  return { stage: to, range: rules.rangeText(ordered[to - 1]) };
}

// 관리자에게 보여줄 반영 결과 (역할 추가·회수, 별명, 실패 이유)
function syncLines(s) {
  if (!s) return [];
  if (s.skipped) return ['(서버에 없는 사람이라 역할·별명은 적용 안 함)'];
  const out = [];
  if (s.added.length) out.push(`역할 추가: ${roleList(s.added)}`);
  if (s.removed.length) out.push(`역할 회수: ${roleList(s.removed)}`);
  if (s.nick !== undefined) out.push(`별명 → ${s.nick ?? '(서버 별명 지움)'}`);
  for (const e of s.errors) out.push(`⚠️ ${e}`);
  return out;
}

// /포인트 의 기록 한 줄: "<날짜> 추가 +100P → 250P · 사유"
// <t:유닉스초:d> 는 디스코드가 보는 사람 시간대의 날짜로 바꿔 보여 준다
function ledgerLine(e) {
  const ts = Math.floor(new Date(e.createdAt).getTime() / 1000);
  const delta = e.delta >= 0 ? `+${e.delta}` : `${e.delta}`;
  return `<t:${ts}:d> ${points.LABEL[e.reason] ?? e.reason} ${delta}P → ${e.after}P${e.note ? ` · ${e.note}` : ''}`;
}

// 역할~역할5 칸에서 고른 역할 ID 들 (빈 칸·중복 제외)
const pickRoles = (options) => [...new Set(ROLE_SLOTS.map((n) => options.getRole(n)?.id).filter(Boolean))];

// ctx: { sync(guildId, userId) → 결과, resyncAll(guildId, extraManaged) → { count }, send(channelId, message) }
// 포인트·구간·알림은 모두 명령을 쓴 서버(interaction.guildId) 것이다.
async function handleCommand(interaction, ctx) {
  const { commandName: name, options, guildId } = interaction;

  // ---------- /포인트 [유저] ----------
  if (name === '포인트') {
    const user = options.getUser('유저') ?? interaction.user;
    const [balance, recent] = await Promise.all([points.getBalance(guildId, user.id), points.recentLedger(guildId, user.id)]);
    const body = recent.length ? `\n최근 기록\n${recent.map(ledgerLine).join('\n')}` : '';
    return interaction.reply(ephemeral(`<@${user.id}> **${balance}P**${body}`));
  }

  // ---------- /포인트추가 · /포인트제거 · /포인트지정 ----------
  // 1) 기록 → 2) 그 사람 역할·별명 반영 → 3) 알림 채널에 게시 → 4) 관리자에게 결과
  if (MODE[name]) {
    const mode = MODE[name];
    const user = options.getUser('유저', true);
    if (user.bot) return interaction.reply(ephemeral('봇에게는 기록할 수 없습니다.'));
    const amount = options.getInteger('숫자', true);
    const note = options.getString('사유');
    // 역할·별명 반영에 몇 초 걸릴 수 있어 "생각 중…" 을 먼저 띄운다 (디스코드는 3초 안에 답해야 함)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const r = await points.record(guildId, user.id, mode, amount, interaction.user.id, note);
    const s = await ctx.sync(guildId, user.id);
    const notify = await settings.getNotify(guildId);
    let sent = '';
    if (notify.channelId) {
      const msg = recordNotice({
        adminId: interaction.user.id, userId: user.id, mode, amount, note, ...r,
        added: s.added ?? [], stageUp: stageUpOf(await rules.listRules(guildId), r.before, r.after),
        notifyRoleIds: notify.roleIds,
      });
      sent = await ctx.send(notify.channelId, msg).then(() => '', (e) => `\n⚠️ 알림 채널에 못 올림: ${e.message}`);
    }
    const lines = [`<@${user.id}> 포인트 ${points.LABEL[mode]} ${amountText(mode, amount)} — ${r.before}P → **${r.after}P**`, ...syncLines(s)];
    return interaction.editReply({ content: lines.join('\n') + sent, allowedMentions: { parse: [] } });
  }

  // ---------- /포인트역할 기능:추가|제거|목록 ----------
  if (name === '포인트역할') {
    const fn = options.getString('기능', true);
    if (fn === 'list') {
      const list = await rules.listRules(guildId);
      const body = list.length
        ? list.map((r) => `${rules.rangeText(r)} → ${roleList(r.roleIds)}`).join('\n')
        : '지정된 구간이 없습니다.';
      return interaction.reply(ephemeral(body));
    }
    const rangeArg = options.getString('포인트');
    if (!rangeArg) return interaction.reply(ephemeral('포인트 구간을 적어 주세요. 예: `0-100` 또는 `100`'));
    const range = rules.parseRange(rangeArg);
    const roleIds = pickRoles(options);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let head;
    let extraManaged = [];
    if (fn === 'add') {
      const rule = await rules.addRule(guildId, range, roleIds);
      head = `${rules.rangeText(rule)} → ${roleList(rule.roleIds)}`;
      const overlaps = (await rules.listRules(guildId)).filter((r) => r.id !== rule.id
        && r.min <= (rule.max ?? Infinity) && rule.min <= (r.max ?? Infinity));
      if (overlaps.length) head += `\n⚠️ 겹치는 구간: ${overlaps.map(rules.rangeText).join(', ')} (겹치면 두 구간 역할을 모두 받습니다)`;
    } else {
      const { rule, removedRoleIds } = await rules.removeRule(guildId, range, roleIds);
      extraManaged = removedRoleIds;
      head = rule ? `${rules.rangeText(rule)} 에서 ${roleList(removedRoleIds)} 뺌 → 남은 역할 ${roleList(rule.roleIds)}` : `${rules.rangeText(range)} 구간 삭제`;
    }
    // 구간이 바뀌었으니 이 서버에 기록된 모든 사람에게 다시 적용 (이때는 알림을 보내지 않는다)
    await interaction.editReply({ content: `${head}\n기록된 사람들에게 적용 중…`, allowedMentions: { parse: [] } });
    const { count } = await ctx.resyncAll(guildId, extraManaged);
    return interaction.editReply({ content: `${head}\n✅ ${count}명에게 적용 완료`, allowedMentions: { parse: [] } });
  }

  // ---------- /포인트알림 [채널] [끄기] [역할] ----------
  // 채널을 고르면 그 채널, 비우면 이 명령을 쓴 채널로 켠다(구간 돌파 때 멘션할 역할 1개도 함께 저장). 끄기:True 면 끈다.
  // 역할을 비우고 다시 쓰면 역할 멘션은 빠진다(설정은 매번 통째로 바뀜).
  if (name === '포인트알림') {
    if (options.getBoolean('끄기')) {
      await settings.setNotify(guildId, null, []);
      return interaction.reply(ephemeral('알림을 껐습니다.'));
    }
    const channelId = options.getChannel('채널')?.id ?? interaction.channelId;
    const roleIds = options.getRole('역할') ? [options.getRole('역할').id] : [];
    await settings.setNotify(guildId, channelId, roleIds);
    const up = roleIds.length ? `해당 유저 + ${roleList(roleIds)}` : '해당 유저';
    return interaction.reply(ephemeral(
      `알림 채널: <#${channelId}>\n· 포인트 기록마다: 해당 유저 멘션\n· 구간을 넘으면: ${up} 멘션`,
    ));
  }
}

module.exports = { data, handleCommand, recordNotice, syncLines };
