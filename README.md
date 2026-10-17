# Draft Room 2026-27

Fantasy basketball draft tools for a 20-team ESPN H2H 11-cat league (9-cat + 3P% + DD, 10-man rosters).

## 1. ESPN draft room extension (Chrome, for whoever runs it)
Adds a side panel to the ESPN draft room that follows the draft by itself: your options grouped by bucket (1.4.0: ESPN's own ranked list is on screen beside it, so the panel shows choices, not a second list), category balance, the draft buckets ticking off live (pink = injury risk in his healthy bucket, gold = rookie), a league table, and a **Share** tab that broadcasts the draft to the live page below.

1. Download [draft-helper-extension.zip](https://github.com/Cuddles-mc/draft-room/raw/main/draft-helper-extension.zip) and unzip it.
2. In Chrome go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped `draft-helper-extension` folder. (Updating: replace the folder, then press the reload arrow on the extension card.)
4. Open the ESPN draft room (practice drafts and mock drafts work too). The panel appears top right; pick your team if it asks.
5. To share: **Share** tab → tick **Broadcast this draft** → copy the link (or each team's personal link) to the group chat.

**Plan (1.3.3):** at your first three picks, **Best pick** shows the pre-draft plan for slots 12, 16 and 17 (500 simulated drafts per option): the pick to take now, buckets of even picks at each pick, and the route for each first pick. Fit takes over after that.

**Model users:** the **League** tab lists the teams that have this model's advice (slots 12 and 17 by default; tick or untick teams there). **Best pick** then shows what the model would take for them before your next pick. They still pick for themselves, so it is a warning about who may not be there, not a certainty.

**The board (17 Oct):** values come from the Draft Room's refined board: injuries, depth charts, every preseason box score (starters with the regulars count as starters, rookies included), and a check against the CBS and FantasyPros season minutes. Players keep their positions in `data.js`, so a host and the live page stay in step even on different builds; if they differ, the panel says so.

## 2. Live page (everyone else, phone or browser, no extension)
Open the link the host shares (`https://cuddles-mc.github.io/draft-room/live.html#t=…`). Pick your team once, or use your personal link, and you'll see your own best pick, team balance, buckets and the league table, updating as picks happen (within about 15-20 seconds).

**Put it on your phone like an app:** iPhone: Safari → Share → *Add to Home Screen*. Android: Chrome menu → *Install app* / *Add to Home screen*. It reopens your draft and team.

## 3. Draft room page (manual)
https://cuddles-mc.github.io/draft-room/ — mark picks yourself; saves in your browser. The board opens as **Buckets** (the extension's tiers): the names left in each bucket, coloured by group (guards, wings, bigs; or switch to type: bigs, shooters, playmakers, scorers), with the coach's suggested and even picks outlined. Tap a name for his line and Mine / Taken. A **List** view is one tap away. The extension colours names the same way. Its **Reading the room** card reads how each team is drafting, and has a **Leans on a model** setting for a team that has the advice but picks for itself: it starts 60% likely to follow the model and its own picks move that either way. Its coach suggests one pick, then shows a **Your choice** group: the options it can't separate plus a rookie and an injury reach, each with its playoff cost, whether he lasts to your next pick, and what he changes category by category. It also shows your likely path at later picks and the plan's buckets, and keeps sharpening while you're on the clock.

Updates travel through ntfy.sh, a free public relay: anyone with the link can see the picks; nothing else is sent.
