// =====================================================================
// 김만식 포인트 봇 — 시작점
// ---------------------------------------------------------------------
// 하는 일
//  1. DB(SQLite 파일) 표 만들기 → 디스코드 로그인
//  2. 로그인되면 슬래시 명령어를 전역 등록 (봇이 들어간 모든 서버에서 사용)
//  3. 명령 처리는 commands.js, 역할·별명 반영은 sync.js 에 맡긴다
//  4. .env 에 LINK_SECRET 이 있으면 uri 봇과 연계 (별명 변수 {PT} — link.js)
//
// 포인트·구간·알림은 모두 서버별이다. 아래 모든 동작에 guildId 가 따라다닌다.
// 실행: npm start  (상시 구동은 kimmansik-bot.service — README 참고)
// =====================================================================
require('dotenv').config(); // .env 를 process.env 로 읽는다 (db.js 보다 먼저 — DB_FILE 때문)
const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const { migrate } = require('./db');
const { UserError, allBalances } = require('./points');
const { listRules } = require('./rules');
const { syncMember } = require('./sync');
const commands = require('./commands');
const link = require('./link');

if (!process.env.DISCORD_TOKEN) {
  console.error('.env 에 DISCORD_TOKEN 이 없습니다. .env.example 참고.');
  process.exit(1);
}
// uri 연계 상태 (서버마다 연결됐는지, 별명을 uri 가 만드는지)
const linkState = new link.LinkState();
let linkOpts = null; // uri 연계가 켜져 있으면 값 푸시에 쓴다 (startLink 에서 채움)

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // 특권 인텐트: 개발자 포털에서 켜야 함
  ],
});

// 역할·별명 적용은 한 번에 하나씩 줄 세워 처리한다.
// 예) 구간을 바꿔 전원 재적용하는 도중에 /포인트추가 가 들어와도 순서대로 처리돼 서로 덮어쓰지 않는다.
let queue = Promise.resolve();
const serial = (fn) => {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
};

// 한 서버·한 사람 반영. 봇이 그 서버에 없으면 건너뜀.
async function syncOne(guildId, userId, rulesList, extraManaged) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { skipped: 'bot-not-in-guild' };
  const r = await syncMember(guild, userId, {
    rules: rulesList, nicknameOwner: linkState.nicknameOwner(guildId), extraManaged,
  });
  if (r.errors?.length) console.warn(`[sync] ${guildId}/${userId}`, r.errors);
  return r;
}

// commands.js 에 넘기는 "디스코드에 닿는 일" 묶음 (테스트에서는 가짜로 바꿔 끼운다)
//   sync      : 한 사람 반영 + (연계 중이면) 그 사람 값을 uri 에 전송
//   resyncAll : 그 서버에 기록된 모든 사람 다시 반영 (구간 변경 시) + 단계 번호가 바뀌었을 수 있으니 uri 에 전체 값 전송
//   send      : 알림 채널에 메시지 보내기
const ctx = {
  sync: (guildId, userId) => serial(async () => {
    const r = await syncOne(guildId, userId, await listRules(guildId), []);
    if (linkOpts) link.pushValues(linkOpts, guildId, [userId]).catch((err) => console.error('[link] 값 전송 실패', err));
    return r;
  }),
  resyncAll: (guildId, extraManaged) => serial(async () => {
    const rulesList = await listRules(guildId);
    const all = await allBalances(guildId);
    for (const { userId } of all) await syncOne(guildId, userId, rulesList, extraManaged);
    if (linkOpts) await link.pushValues(linkOpts, guildId).catch((err) => console.error('[link] 값 전송 실패', err));
    return { count: all.length };
  }),
  send: async (channelId, message) => (await client.channels.fetch(channelId)).send(message),
};

// 로그인 완료 → 명령 등록 → 연계 시작
client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set(commands.data); // 전역 등록 — 봇이 들어간 모든 서버에서 쓴다
  console.log(`${c.user.tag} 준비 완료 (앱 ${c.application.id}, 서버 ${c.guilds.cache.size}곳, 전역 명령 ${commands.data.length}개)`);
  startLink();
});

// 그 서버에 기록이 있는 사람이 다시 들어오면 구간을 다시 적용
client.on(Events.GuildMemberAdd, (member) => {
  if (member.user.bot) return;
  allBalances(member.guild.id)
    .then((all) => (all.some((b) => b.userId === member.id) ? ctx.sync(member.guild.id, member.id) : null))
    .catch((err) => console.error('[join] 구간 적용 실패', err));
});

// 슬래시 명령 처리. 실패하면 사용자에게 알려 주고 봇은 계속 돈다.
//  - UserError(잔액 부족 등): 그 메시지를 그대로 보여 줌
//  - 그 밖의 오류: 로그에 남기고 "오류가 발생했습니다"
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return; // 명령은 서버 전용(DM 에선 안 보임)
  try {
    await commands.handleCommand(interaction, ctx);
  } catch (err) {
    if (!(err instanceof UserError)) console.error('[interaction]', err);
    const content = err instanceof UserError ? err.message : '오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
    const reply = interaction.deferred || interaction.replied
      ? interaction.editReply({ content, allowedMentions: { parse: [] } })
      : interaction.reply({ content, flags: MessageFlags.Ephemeral });
    await reply.catch(() => {});
  }
});

// uri 봇 연계: LINK_SECRET 이 있을 때만 켠다. uri 에 연결된 서버마다 따로 동작한다.
function startLink() {
  const secret = process.env.LINK_SECRET;
  if (!secret) {
    console.log('[link] LINK_SECRET 없음 — uri 연계 꺼짐, 별명은 이 봇이 직접 바꿈');
    return;
  }
  linkOpts = {
    apiUrl: process.env.LINK_API_URL || 'http://127.0.0.1:4200/dashboard/api/link',
    linkId: process.env.LINK_ID || 'kimmansik',
    variable: process.env.LINK_VARIABLE || 'PT',
    secret,
    clientId: client.user.id,
    state: linkState,
  };
  // 하트비트 1회: 상태 받기 → 연결된 서버마다 전체 값 보내기 → 별명을 돌려받은 서버는 숫자 다시 붙이기
  const beat = async () => {
    const { released } = await link.sendHeartbeat(linkOpts);
    for (const g of linkState.connectedGuilds()) {
      await link.pushValues(linkOpts, g).catch((err) => console.error(`[link] 값 전송 실패 (서버 ${g})`, err));
    }
    // uri 가 별명을 내려놓은 서버는 이 봇이 다시 숫자를 붙인다
    for (const g of released) await ctx.resyncAll(g, []);
  };
  const run = () => beat().catch((err) => console.error('[link] 하트비트 오류', err));
  run();
  setInterval(run, link.HEARTBEAT_MS);
}

// 시작: 표 만들기 → 로그인. 실패하면 종료(systemd 가 5초 뒤 다시 켠다)
Promise.resolve()
  .then(migrate)
  .then(() => client.login(process.env.DISCORD_TOKEN))
  .catch((err) => {
    console.error('시작 실패', err);
    process.exit(1);
  });
