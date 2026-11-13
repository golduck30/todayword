// 게임 로직. 자모 수/타임어택 설정은 WORD_LENGTHS, TIME_ATTACK_SEC에서 관리합니다.
        const firebaseConfig = {
            apiKey: "AIzaSyBZmxJUr5oaZttF7oIYJSEBb5RgjVQjInY",
            authDomain: "cofirm-board.firebaseapp.com",
            databaseURL: "https://cofirm-board-default-rtdb.firebaseio.com",
            projectId: "cofirm-board",
            storageBucket: "cofirm-board.appspot.com",
            messagingSenderId: "367825644618",
            appId: "1:367825644618:web:3f236c72c0d5347878ab3"
        };
        let db = null;
        try {
            firebase.initializeApp(firebaseConfig);
            db = firebase.database();
        } catch (e) {
            console.error('Firebase 초기화 실패:', e);
        }

        let myUid = null;
        try { myUid = localStorage.getItem('wordle_uid'); } catch (e) {}
        if (!myUid) {
            myUid = 'user_' + Math.random().toString(36).substr(2, 9);
            try { localStorage.setItem('wordle_uid', myUid); } catch (e) {}
        }

        let wordLength = 5;
        let secretWord = "";
        let currentGuess = "";
        let submittedGuesses = [];
        const maxGuesses = 5;
        let isGameOver = false;
        let isResultsShown = false;
        let solvedTimestamp = null;

        let keyboardState = {};

        // 출제자 전용 상태
        let makerWord = "";
        let hasMasterSetWord = false;

        let currentRoomCode = null;
        let myNickname = "플레이어";
        let isMaster = false;
        let isSpectator = false;
        let roomDataListener = null;

        // 방장(👑) / 힌트 투표 상태
        let hostUid = null;
        let isHost = false;
        let lastRoomData = null;
        const MAX_HINTS_PER_ROUND = 2;
        const HINT_VOTE_SECONDS = 30;
        const HINT_COOLDOWN_SECONDS = 15;
        let hintTimer = null;
        let hintInitDone = false;
        let lastAnnouncedHintId = null;
        let hintModalDismissedId = null;
        let hintRenderSig = '';
        let hintBannerTimer = null;

        // 타임어택 / 점수 / 경고 상태
        const WORD_LENGTHS = [5, 6, 7, 8];
        // 타임어택 제한 시간(초): 5글자 4분 · 6글자 6분 · 7글자 8분 · 8글자 10분
        const TIME_ATTACK_SEC = { 5: 240, 6: 360, 7: 480, 8: 600 };
        let selectedTimeMode = 'attack';   // 'attack' = 타임어택, 'free' = 무제한
        let timedOut = false;
        let timerInterval = null;
        let timeUpKey = null;
        let leaderUids = new Set();
        let leaderInit = false;
        let myPrevRank = null;
        let rankExpanded = false;
        let toastTimer = null;
        let lastCoinKey = null;

        // 활동 상태: 입력/클릭 시각과 접속 heartbeat를 별도로 기록합니다.
        const ACTIVITY_HEARTBEAT_MS = 20000;
        const ACTIVITY_OFFLINE_MS = 90000;
        const ACTIVITY_IDLE_MS = 180000;
        let activityInterval = null;
        let lastActivityWrite = 0;
        let localActionAt = Date.now();
        function publishActivity(force = false) {
            if (!db || !currentRoomCode || !myUid) return;
            const now = Date.now();
            if (!force && now - lastActivityWrite < 5000) return;
            lastActivityWrite = now;
            const path = db.ref(`rooms/${currentRoomCode}/players/${myUid}`);
            path.update({ lastSeenAt: firebase.database.ServerValue.TIMESTAMP,
                lastActionAt: localActionAt + serverOffset,
                pageHidden: document.hidden });
        }
        function notePlayerActivity() {
            if (!currentRoomCode) return;
            localActionAt = Date.now();
            publishActivity();
        }
        document.addEventListener('pointerdown', notePlayerActivity, {passive:true});
        document.addEventListener('keydown', notePlayerActivity, {passive:true});
        document.addEventListener('visibilitychange', () => { if (currentRoomCode) { localActionAt = Date.now(); publishActivity(true); } });
        function stopActivityHeartbeat() { clearInterval(activityInterval); activityInterval = null; }
        function startActivityHeartbeat() {
            stopActivityHeartbeat(); localActionAt = Date.now(); lastActivityWrite = 0;
            publishActivity(true);
            activityInterval = setInterval(() => {
                publishActivity(true);
                if (lastRoomData && lastRoomData.players) {
                    updateSpectatorBoard(lastRoomData.players, lastRoomData.masterUid);
                    if (isHost && !document.getElementById('hostModal').classList.contains('hidden')) renderHostPanel();
                }
            }, ACTIVITY_HEARTBEAT_MS);
        }
        function activityInfo(p) {
            const now = serverNow();
            if (!p || !p.lastSeenAt) return {label:'상태 확인 중',cls:'text-slate-500',online:true};
            const connected = now - Number(p.lastSeenAt) < ACTIVITY_OFFLINE_MS;
            const actionAge = now - Number(p.lastActionAt || p.lastSeenAt);
            if (!connected) return {label:'🔴 연결 끊김 의심',cls:'text-rose-600',online:false};
            if (p.spectator) return {label:'👀 관전 중',cls:'text-slate-600',online:true};
            if (p.completed) return {label:'✅ 풀이 완료',cls:'text-emerald-600',online:true};
            if (p.pageHidden) return {label:'📱 다른 화면 · 접속 유지',cls:'text-amber-600',online:true};
            if (actionAge > ACTIVITY_IDLE_MS) return {label:'🟠 최근 조작 없음 · 접속 중',cls:'text-amber-600',online:true};
            if (actionAge < 12000) return {label:'🟢 입력/조작 중',cls:'text-emerald-600',online:true};
            return {label:'🧠 생각하며 풀이 중',cls:'text-sky-600',online:true};
        }
        function protectedSolver(p) {
            return !!(lastRoomData && lastRoomData.secretWord && p && !p.spectator && !p.completed && activityInfo(p).online);
        }
        // 서버 시간 보정
        let serverOffset = 0;
        if (db) {
            try { db.ref('.info/serverTimeOffset').on('value', snap => { serverOffset = snap.val() || 0; }); } catch (e) {}
        }
        const serverNow = () => Date.now() + serverOffset;
        const crown = (uid) => (uid && uid === hostUid) ? '👑 ' : '';

        const boardEl = document.getElementById('board');

        // 자모 조합 검증 함수
        function isValidJamoSequence(jamoStr) {
            if (!jamoStr || jamoStr.length === 0) return true;
            if (typeof Hangul === 'undefined') return false;

            return assembleCandidates(jamoStr).some(w => Hangul.isCompleteAll(w));
        }

        function normalizeJamo(jamoStr) {
            return jamoStr
                .replace(/ㅏㅣ/g, 'ㅐ')
                .replace(/ㅑㅣ/g, 'ㅒ')
                .replace(/ㅓㅣ/g, 'ㅔ')
                .replace(/ㅕㅣ/g, 'ㅖ');
        }

        const DOUBLE_JAMO = { 'ㄱ': 'ㄲ', 'ㄷ': 'ㄸ', 'ㅂ': 'ㅃ', 'ㅅ': 'ㅆ', 'ㅈ': 'ㅉ' };

        function jamoVariants(str) {
            const results = [];
            (function rec(i, acc) {
                if (i >= str.length) { results.push(acc); return; }
                const c = str[i];
                if (DOUBLE_JAMO[c] && str[i + 1] === c) rec(i + 2, acc + DOUBLE_JAMO[c]);
                rec(i + 1, acc + c);
            })(0, '');
            return results;
        }

        function assembleCandidates(jamoStr) {
            const set = new Set();
            jamoVariants(jamoStr).forEach(v => {
                set.add(Hangul.assemble(normalizeJamo(v).split('')));
            });
            return [...set];
        }

        // 사전에 없지만 허용할 단어
        // EXTRA_WORDS는 dictionary.js에서 관리합니다.

        function isDictionaryWord(jamoStr) {
            if (typeof Hangul === 'undefined' || !isDictionaryReady(wordLength)) return false;
            return assembleCandidates(jamoStr).some(w => Hangul.isCompleteAll(w) && dictSet.has(w));
        }

        function assemblePreview(jamoStr) {
            if (typeof Hangul === 'undefined') return '';
            const cands = assembleCandidates(jamoStr);
            if (typeof dictSet !== 'undefined') {
                const matched = cands.find(w => Hangul.isCompleteAll(w) && dictSet.has(w));
                if (matched) return matched;
            }
            return cands.find(w => Hangul.isCompleteAll(w)) || cands[0] || '';
        }

        // [업그레이드 1] 현재 방에 문제를 풀 참가자(출제자·관전자 제외)가 몇 명인지 계산
        function getActiveParticipantCount() {
            if (!lastRoomData || !lastRoomData.players) return 0;
            return Object.entries(lastRoomData.players)
                .filter(([uid, p]) => uid !== lastRoomData.masterUid && !p.spectator)
                .length;
        }

        function setWordLength(len) {
            if (isSpectator) { showToast("관전 중에는 글자 수를 바꿀 수 없어요."); return; }
            if (currentRoomCode && !isMaster) { showToast("글자 수는 출제자만 바꿀 수 있어요."); return; }
            if (currentRoomCode && hasMasterSetWord) { showToast("이미 출제했어요. 글자 수는 다음 라운드에 바꿀 수 있어요."); return; }
            if (submittedGuesses.length > 0 || (isMaster && makerWord.length > 0)) {
                if (!confirm("글자 수를 변경하면 진행 중인 입력이 초기화됩니다. 변경하시겠습니까?")) return;
            }
            wordLength = len;
            ensureDictionaryForLength(wordLength).catch(() => showToast("사전 로딩에 실패했습니다. 새로고침해 주세요."));
            setWordLengthUI(wordLength);

            if (currentRoomCode && isMaster) {
                db.ref(`rooms/${currentRoomCode}`).update({ targetLength: wordLength });
            }

            resetGameData();
        }

        function initBoard() {
            boardEl.innerHTML = '';
            boardEl.className = `grid grid-rows-5 ${wordLength === 8 ? 'gap-1.5' : 'gap-2'} my-auto board-${wordLength}`;
            boardEl.style.width = `min(100%, ${wordLength * 52 + (wordLength - 1) * 8}px)`;

            for (let i = 0; i < maxGuesses; i++) {
                const row = document.createElement('div');
                row.className = `grid ${wordLength === 8 ? 'gap-1' : 'gap-2'}`;
                row.style.gridTemplateColumns = `repeat(${wordLength}, minmax(0, 1fr))`;
                for (let j = 0; j < wordLength; j++) {
                    const tile = document.createElement('div');
                    tile.className = 'tile';
                    tile.id = `tile-${i}-${j}`;
                    row.appendChild(tile);
                }
                boardEl.appendChild(row);
            }
        }

        function evaluateGuess(guess, target) {
            const res = new Array(guess.length).fill('absent');
            if (!target || target.length !== guess.length) return res;

            const targetChars = target.split('');
            const guessChars = guess.split('');
            const targetCounts = {};

            for (let i = 0; i < targetChars.length; i++) {
                const char = targetChars[i];
                if (guessChars[i] === char) {
                    res[i] = 'correct';
                } else {
                    targetCounts[char] = (targetCounts[char] || 0) + 1;
                }
            }

            for (let i = 0; i < guessChars.length; i++) {
                if (res[i] === 'correct') continue;
                const char = guessChars[i];
                if (targetCounts[char] && targetCounts[char] > 0) {
                    res[i] = 'present';
                    targetCounts[char]--;
                }
            }

            return res;
        }

        function renderBoard() {
            applyTileSkin();
            if (isMaster) {
                for (let i = 0; i < maxGuesses; i++) {
                    for (let j = 0; j < wordLength; j++) {
                        const tile = document.getElementById(`tile-${i}-${j}`);
                        if (!tile) continue;
                        tile.className = 'tile';
                        if (i === 0) {
                            const char = hasMasterSetWord ? (secretWord[j] || "") : (makerWord[j] || "");
                            tile.textContent = char;
                            tile.classList.add('maker-input');
                            if (char) tile.classList.add('filled');
                        } else {
                            tile.textContent = "";
                        }
                    }
                }
                clearKeyboardColors();
                return;
            }

            for (let i = 0; i < maxGuesses; i++) {
                const isSubmitted = i < submittedGuesses.length;
                const guess = isSubmitted ? submittedGuesses[i] : (i === submittedGuesses.length ? currentGuess : "");
                const evaluation = isSubmitted ? evaluateGuess(guess, secretWord) : null;

                for (let j = 0; j < wordLength; j++) {
                    const tile = document.getElementById(`tile-${i}-${j}`);
                    if (!tile) continue;
                    const char = guess[j] || "";
                    tile.textContent = char;
                    tile.className = 'tile';
                    if (char) tile.classList.add('filled');

                    if (isSubmitted && evaluation) {
                        tile.classList.add(evaluation[j]);
                    }
                }
            }
            updateKeyboardColors();
        }

        function syncMyProgress() {
            if (!db || !currentRoomCode || isMaster || isSpectator) return;
            const solved = !!secretWord && submittedGuesses.includes(secretWord);
            const isCompleted = solved || submittedGuesses.length >= maxGuesses || timedOut;
            const updateData = {
                nickname: myNickname,
                guesses: submittedGuesses,
                completed: isCompleted,
                timedOut: timedOut ? true : null,
                avatar: myAvatar(),
                nameStyle:safeNameStyle(profile.eq.name)
            };
            if (solved && !solvedTimestamp) {
                solvedTimestamp = serverNow();
                updateData.solvedTimestamp = solvedTimestamp;
            }
            db.ref(`rooms/${currentRoomCode}/players/${myUid}`).update(updateData);
        }

        function clearKeyboardColors() {
            document.querySelectorAll('.key').forEach(key => {
                const char = key.textContent.trim();
                if (char.length !== 1) return;
                key.className = 'key flex-1 py-3';
            });
        }

        function updateKeyboardColors() {
            if (isMaster || isSpectator) { clearKeyboardColors(); return; }

            submittedGuesses.forEach(guess => {
                const evalRes = evaluateGuess(guess, secretWord);
                for (let j = 0; j < guess.length; j++) {
                    const char = guess[j];
                    const status = evalRes[j];
                    let val = 1;
                    if (status === 'correct') val = 3;
                    else if (status === 'present') val = 2;

                    if (!keyboardState[char] || val > keyboardState[char]) {
                        keyboardState[char] = val;
                    }
                }
            });

            const keyElements = document.querySelectorAll('.key');
            keyElements.forEach(key => {
                const char = key.textContent.trim();
                if (char.length !== 1) return;
                
                const status = keyboardState[char] || 0;
                key.className = 'key flex-1 py-3';
                if (status === 3) key.classList.add('correct');
                else if (status === 2) key.classList.add('present');
                else if (status === 1) key.classList.add('absent');
            });
        }

        function handleKey(char) {
            if (isSpectator) return;
            if (!/^[ㄱ-ㅎㅏ-ㅣ]$/.test(char)) return;
            if (isMaster) {
                if (hasMasterSetWord) return;
                if (makerWord.length < wordLength) {
                    makerWord = makerWord + char;
                    renderBoard();
                }
                return;
            }

            if (isGameOver) return;
            if (submittedGuesses.length >= maxGuesses) return;
            if (currentGuess.length < wordLength) {
                currentGuess = currentGuess + char;
                renderBoard();
            }
        }

        function handleDelete() {
            if (isSpectator) return;
            if (isMaster) {
                if (hasMasterSetWord) return;
                if (makerWord.length > 0) {
                    makerWord = makerWord.slice(0, -1);
                    renderBoard();
                }
                return;
            }

            if (isGameOver) return;
            if (currentGuess.length > 0) {
                currentGuess = currentGuess.slice(0, -1);
                renderBoard();
            }
        }

        function handleSubmit() {
            if (isSpectator) return;
            if (!isDictionaryReady(wordLength)) {
                showToast("단어사전을 불러오는 중이에요. 잠시 후 다시 제출해주세요.");
                ensureDictionaryForLength(wordLength).catch(() => showToast("사전 로딩 실패. 인터넷 연결 후 다시 시도해주세요."));
                return;
            }
            if (isMaster) {
                if (hasMasterSetWord) {
                    showToast("이미 출제가 완료되었습니다!");
                    return;
                }
                if (getActiveParticipantCount() === 0) {
                    showToast("아직 문제를 풀 참가자가 없어요! 참가자가 입장한 뒤에 출제해주세요.");
                    return;
                }
                if (makerWord.length !== wordLength) {
                    showToast(`첫번째 줄에 ${wordLength}자모를 모두 채워주세요!`);
                    return;
                }
                if (!isValidJamoSequence(makerWord)) {
                    showToast(`완성되지 않은 글자가 있어요! (${assemblePreview(makerWord)})`);
                    return;
                }
                if (!isDictionaryWord(makerWord)) {
                    showToast(`사전에 없는 단어예요! (${assemblePreview(makerWord)})`);
                    return;
                }
                if (!db || !currentRoomCode) {
                    showToast("서버에 연결되지 않아 출제할 수 없습니다.");
                    return;
                }
                db.ref(`rooms/${currentRoomCode}`).update({
                    secretWord: makerWord,
                    targetLength: wordLength,
                    timeLimit: selectedTimeMode === 'attack' ? (TIME_ATTACK_SEC[wordLength] || 0) : 0,
                    startedAt: firebase.database.ServerValue.TIMESTAMP,
                    hintState: null,
                    left: null
                });
                hasMasterSetWord = true;
                const tlSec = selectedTimeMode === 'attack' ? (TIME_ATTACK_SEC[wordLength] || 0) : 0;
                showToast(`🎯 문제가 출제되었습니다! (${assemblePreview(makerWord)}) · ${tlSec ? '⏱ ' + (tlSec / 60) + '분 타임어택' : '♾️ 무제한'}`);
                toggleMasterUI();
                renderBoard();
                return;
            }

            if (isGameOver) return;
            if (submittedGuesses.length >= maxGuesses) return;

            if (!secretWord) {
                showToast("출제자가 아직 문제를 출제하지 않았습니다!");
                return;
            }

            if (currentGuess.length !== wordLength) {
                showToast(`${wordLength}자모를 모두 입력한 뒤 제출해주세요!`);
                return;
            }

            if (!isValidJamoSequence(currentGuess)) {
                showToast(`완성되지 않은 글자가 있어요! (${assemblePreview(currentGuess)})`);
                return;
            }

            if (currentGuess !== secretWord && !isDictionaryWord(currentGuess)) {
                showToast(`사전에 없는 단어예요! (${assemblePreview(currentGuess)})`);
                return;
            }

            const newGuess = currentGuess;
            submittedGuesses.push(newGuess);
            currentGuess = "";
            renderBoard();
            syncMyProgress();

            if (newGuess === secretWord || submittedGuesses.length >= maxGuesses) {
                isGameOver = true;
                updateHintButton();
                refreshRoomView();
                if (newGuess === secretWord) {
                    showToast("정답을 맞췄습니다! 다른 참가자들을 기다리는 중...");
                    playVictoryEffect();
                } else {
                    showToast("😢 아쉽게 실패! 아래에서 정답을 확인할 수 있어요.", 3000);
                }
            } else {
                showToast(`${submittedGuesses.length}번째 시도 완료! 다음 단어를 입력하세요.`);
            }
        }

        function showToast(msg, ms) {
            const toast = document.getElementById('toast');
            toast.textContent = msg;
            toast.classList.remove('opacity-0');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => toast.classList.add('opacity-0'), ms || 2200);
        }

        function openLobbyModal() {
            document.getElementById('lobbyModal').classList.remove('hidden');
        }
        function closeLobbyModal() {
            document.getElementById('lobbyModal').classList.add('hidden');
        }
        function showJoinInput() {
            document.getElementById('joinCodeArea').classList.remove('hidden');
        }

        function createRoom() {
            const nick = document.getElementById('nicknameInput').value.trim();
            if (!nick) { alert("닉네임을 입력해주세요!"); return; }
            switchProfile(nick).then(createRoomNow);   // 같은 닉네임이면 코인/아이템 불러오기
        }

        function joinRoom(asSpectator = false) {
            const nick = document.getElementById('nicknameInput').value.trim();
            const roomCode = document.getElementById('roomCodeInput').value.trim();
            if (!nick) { alert("닉네임을 입력해주세요!"); return; }
            if (roomCode.length !== 6) { alert("올바른 6자리 방 코드를 입력해주세요!"); return; }
            switchProfile(nick).then(() => joinRoomNow(asSpectator));
        }

        function createRoomNow() {
            const nick = document.getElementById('nicknameInput').value.trim();
            if (!nick) { alert("닉네임을 입력해주세요!"); return; }
            if (!db) { alert("서버(Firebase)에 연결할 수 없습니다. 인터넷 연결을 확인해주세요."); return; }
            myNickname = nick;

            const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
            currentRoomCode = roomCode;
            isMaster = true;
            isSpectator = false;

            db.ref(`rooms/${roomCode}`).set({
                secretWord: "",
                targetLength: wordLength,
                masterUid: myUid,
                masterName: myNickname,
                hostUid: myUid,
                hostName: myNickname,
                round: 1,
                players: {
                    [myUid]: { nickname: myNickname, guesses: [], completed: true, solvedTimestamp: 0, score: 0, avatar: myAvatar(), nameStyle:safeNameStyle(profile.eq.name) }
                }
            }).then(() => {
                closeLobbyModal();
                enterRoomMode(roomCode, "", true);
                showToast("대결 방이 생성되었습니다!");
            });
        }

        function joinRoomNow(asSpectator = false) {
            const nick = document.getElementById('nicknameInput').value.trim();
            const roomCode = document.getElementById('roomCodeInput').value.trim();
            if (!nick) { alert("닉네임을 입력해주세요!"); return; }
            if (roomCode.length !== 6) { alert("올바른 6자리 방 코드를 입력해주세요!"); return; }
            if (!db) { alert("서버(Firebase)에 연결할 수 없습니다. 인터넷 연결을 확인해주세요."); return; }
            db.ref(`rooms/${roomCode}`).once('value', snapshot => {
                const room = snapshot.val();
                if (!room) { alert("존재하지 않는 방입니다."); return; }

                const players = room.players || {};
                const left = room.left || {};
                const scoreArch = room.scoreArchive || {};

                let prev = null, prevUid = null, prevFromArchive = false, takeover = false;
                if (players[myUid]) { prev = players[myUid]; prevUid = myUid; }
                else if (left[myUid]) { prev = left[myUid]; prevUid = myUid; prevFromArchive = true; }
                else {
                    const findByNick = obj => Object.keys(obj).find(u => u !== myUid && obj[u] && obj[u].nickname === nick);
                    const u1 = findByNick(players);
                    if (u1) { prev = players[u1]; prevUid = u1; takeover = true; }
                    else {
                        const u2 = findByNick(left);
                        if (u2) { prev = left[u2]; prevUid = u2; prevFromArchive = true; }
                    }
                }
                if (takeover && !confirm(`'${nick}' 닉네임으로 이미 참여 중인 사람이 있어요.\n나갔다가 다시 들어온 거라면 [확인]을 눌러 이어서 진행하세요.\n다른 사람이라면 [취소]를 누르고 닉네임을 바꿔주세요.`)) return;

                // 누적 점수 복원 (이전 기록 / 나갔다 돌아온 경우)
                let prevScore = 0, scoreRestoreUid = null;
                if (prev && typeof prev.score === 'number') prevScore = prev.score;
                else {
                    const au = scoreArch[myUid] ? myUid : Object.keys(scoreArch).find(u => scoreArch[u] && scoreArch[u].nickname === nick);
                    if (au) { prevScore = scoreArch[au].score || 0; scoreRestoreUid = au; }
                }
                const joiningAsMaster = (room.masterUid === myUid) || (takeover && room.masterUid === prevUid);
                if (asSpectator && joiningAsMaster) {
                    alert("현재 출제자는 관전 전용으로 입장할 수 없어요. [참여하기]로 입장해주세요.");
                    return;
                }

                // [업그레이드 1] 기존 참가자가 0명일 때 들어온 첫 번째 참가자는 이미 문제가 출제됐더라도 관전자가 되지 않고 바로 문제 풀이에 참여!
                const activeParticipants = Object.entries(players).filter(([u, p]) => u !== room.masterUid && !p.spectator);
                const prevParticipant = !!prev && !prev.spectator;
                const lateJoin = !asSpectator && !joiningAsMaster && !!room.secretWord && !prevParticipant && activeParticipants.length > 0;
                const newSpectator = asSpectator || lateJoin;

                let resume = null;
                if (!newSpectator && !joiningAsMaster && prevParticipant) {
                    const raw = Array.isArray(prev.guesses) ? prev.guesses : Object.values(prev.guesses || {});
                    resume = {
                        guesses: raw.filter(x => typeof x === 'string').slice(0, maxGuesses),
                        solvedTimestamp: prev.solvedTimestamp || 0
                    };
                }
                const solved = !!resume && !!room.secretWord && resume.guesses.includes(room.secretWord);
                const completed = joiningAsMaster || newSpectator || (!!resume && (solved || resume.guesses.length >= maxGuesses));

                myNickname = nick;
                currentRoomCode = roomCode;
                isMaster = joiningAsMaster;
                isSpectator = newSpectator;
                if (room.targetLength) {
                    wordLength = room.targetLength;
                    ensureDictionaryForLength(wordLength).catch(() => showToast("사전 로딩 실패. 인터넷 연결을 확인하세요."));
                    setWordLengthUI(wordLength);
                }

                const updates = {
                    [`players/${myUid}`]: {
                        nickname: nick,
                        guesses: resume ? resume.guesses : [],
                        completed: completed,
                        solvedTimestamp: resume ? resume.solvedTimestamp : 0,
                        spectator: newSpectator,
                        waiting: lateJoin ? true : null,
                        score: prevScore,
                        avatar: myAvatar(),
                nameStyle:safeNameStyle(profile.eq.name)
                    },
                    [`kicked/${myUid}`]: null
                };
                if (takeover) {
                    updates[`players/${prevUid}`] = null;
                    updates[`kicked/${prevUid}`] = 'takeover';
                    if (room.masterUid === prevUid) { updates.masterUid = myUid; updates.masterName = nick; }
                    if (room.hostUid === prevUid) { updates.hostUid = myUid; updates.hostName = nick; }
                }
                if (prevFromArchive) updates[`left/${prevUid}`] = null;
                if (scoreRestoreUid) updates[`scoreArchive/${scoreRestoreUid}`] = null;
                db.ref(`rooms/${roomCode}`).update(updates);

                closeLobbyModal();
                enterRoomMode(roomCode, room.secretWord || "", isMaster, resume);

                if (lateJoin) showToast("이번 라운드는 관전만 가능해요. 다음 게임부터 참여할 수 있어요!");
                else if (asSpectator) showToast("관전 모드로 입장했습니다!");
                else if (resume && resume.guesses.length > 0) showToast("이전 풀이 기록을 불러왔어요. 이어서 풀어보세요!");
                else if (joiningAsMaster && room.secretWord) showToast("출제자로 다시 입장했어요.");
                else showToast("방에 입장했습니다!");
            });
        }

        function setWordLengthUI(len) {
            WORD_LENGTHS.forEach(l => {
                const btn = document.getElementById(`lenBtn-${l}`);
                if (l === len) btn.classList.add('active');
                else btn.classList.remove('active');
            });
        }

        function enterRoomMode(roomCode, word, masterStatus, resume) {
            secretWord = word;
            isMaster = masterStatus;
            lastRoomData = null; hostUid = null; isHost = false;
            hintInitDone = false; lastAnnouncedHintId = null; hintModalDismissedId = null; hintRenderSig = '';
            document.getElementById('gameModeBadge').textContent = isSpectator ? "관전 모드" : "대결 모드";
            document.getElementById('multiplayerInfo').classList.remove('hidden');
            document.getElementById('dispRoomCode').textContent = roomCode;
            
            toggleMasterUI();

            if (roomDataListener) db.ref(`rooms/${currentRoomCode}`).off('value', roomDataListener);
            roomDataListener = db.ref(`rooms/${currentRoomCode}`).on('value', snapshot => {
                const data = snapshot.val();
                if (!data) return;

                lastRoomData = data;
                if (data.kicked && data.kicked[myUid]) { handleKicked(data.kicked[myUid]); return; }
                hostUid = data.hostUid || null;
                isHost = !!hostUid && hostUid === myUid;

                const meRec = data.players && data.players[myUid];
                if (meRec && !!meRec.spectator !== isSpectator) {
                    const wasSpectator = isSpectator;
                    isSpectator = !!meRec.spectator;
                    if (wasSpectator && !isSpectator) showToast(data.secretWord ? "🎮 이번 라운드부터 문제를 풀 수 있어요!" : "🎮 문제 풀기 모드예요! 출제를 기다려 주세요.");
                    else if (!wasSpectator && isSpectator) showToast("👀 관전 모드로 전환됐어요.");
                }

                if (WORD_LENGTHS.includes(Number(data.targetLength)) && data.targetLength !== wordLength) {
                    wordLength = data.targetLength;
                    ensureDictionaryForLength(wordLength).catch(() => showToast("사전 로딩 실패. 인터넷 연결을 확인하세요."));
                    setWordLengthUI(wordLength);
                    resetGameData();
                }

                const newWord = data.secretWord || "";
                const newIsMaster = (data.masterUid === myUid);
                const wordChanged = (secretWord !== newWord);
                const masterChanged = (newIsMaster !== isMaster);

                if (wordChanged) {
                    secretWord = newWord;
                    if (secretWord) hasMasterSetWord = true;
                }
                isMaster = newIsMaster;

                const newRoundStarted = wordChanged && !secretWord;
                if (masterChanged || newRoundStarted || (wordChanged && !isMaster)) {
                    resetGameData();
                }

                document.getElementById('dispMaster').textContent = data.masterName || "알 수 없음";

                toggleMasterUI();
                updateRoomChrome(data);
                updateScoreboard(data);
                updateTimerUI();
                updateSpectateBtn();

                if (data.players) {
                    updateSpectatorBoard(data.players, data.masterUid);

                    if (data.secretWord && !isResultsShown) {
                        const participants = Object.entries(data.players).filter(([uid, p]) => uid !== data.masterUid && !p.spectator);
                        if (participants.length > 0) {
                            const allCompleted = participants.every(([uid, p]) => p.completed);
                            if (allCompleted) {
                                isResultsShown = true;
                                showResultsModal(data);
                            }
                        }
                    }
                }
            });

            resetGameData({ skipSync: true });
            if (isMaster && word) { makerWord = word; hasMasterSetWord = true; }
            if (resume) {
                submittedGuesses = resume.guesses.slice();
                solvedTimestamp = resume.solvedTimestamp || null;
                isGameOver = (!!word && submittedGuesses.includes(word)) || submittedGuesses.length >= maxGuesses;
            }
            renderBoard();
            toggleMasterUI();
            updateHintButton();
            initChat(roomCode); // [업그레이드 3] 채팅방 연결
            leaderUids = new Set(); leaderInit = false; myPrevRank = null; rankExpanded = false;
            startTimerLoop();
            startActivityHeartbeat();
        }

        function toggleMasterUI() {
            const submitBtn = document.getElementById('submitBtn');
            const noticeEl = document.getElementById('masterNotice');
            const dashEl = document.getElementById('spectatorDashboard');
            const timeRow = document.getElementById('timeSelectorRow');
            dashEl.classList.remove('hidden');

            const finished = !!currentRoomCode && !isSpectator && !isMaster && isGameOver;
            const bigDash = isSpectator || finished;

            document.getElementById('board').classList.toggle('hidden', isSpectator);
            document.getElementById('keyboard').classList.toggle('hidden', bigDash);
            dashEl.classList.toggle('max-h-48', !bigDash);
            dashEl.classList.toggle('flex-1', bigDash);
            dashEl.classList.toggle('mt-2', bigDash);

            const showTimeSel = !!currentRoomCode && isMaster && !hasMasterSetWord && !isSpectator;
            timeRow.classList.toggle('hidden', !showTimeSel);
            if (showTimeSel) renderTimeSelector();

            if (isSpectator) {
                const meRec = lastRoomData && lastRoomData.players && lastRoomData.players[myUid];
                noticeEl.classList.remove('hidden');
                noticeEl.textContent = (meRec && meRec.waiting)
                    ? "⏳ 라운드 진행 중에 들어오셨어요. 이번 라운드는 관전만 가능하고, 다음 게임부터 참여할 수 있어요!"
                    : "👀 관전 중이에요. 문제는 풀지 않고, 참가자들의 풀이를 실시간으로 볼 수 있어요.";
                return;
            }

            if (isMaster) {
                noticeEl.classList.remove('hidden');
                const pCount = getActiveParticipantCount();
                const canSetWord = !hasMasterSetWord && pCount > 0;

                submitBtn.textContent = hasMasterSetWord ? "출제완료" : (pCount === 0 ? "참가자 대기중" : "문제 출제");
                submitBtn.className = canSetWord
                    ? "key flex-[2] py-3 bg-amber-600 text-white font-bold"
                    : "key flex-[2] py-3 bg-slate-400 text-white font-bold pointer-events-none";

                if (hasMasterSetWord) {
                    noticeEl.textContent = "🎯 정답 출제 완료! 참가자들의 풀이를 기다리는 중... (못 푼 참가자 1명당 +15점 보너스!)";
                } else if (pCount === 0) {
                    noticeEl.textContent = "⏳ 참가자가 방에 입장하면 문제를 출제할 수 있어요! (방 코드를 공유하세요)";
                } else {
                    noticeEl.textContent = `🎯 첫 번째 줄 타일에 ${wordLength}자모를 입력하고, 진행 방식(타임어택/무제한)을 고른 뒤 [문제 출제]를 누르세요!`;
                }
            } else {
                if (finished) {
                    noticeEl.classList.remove('hidden');
                    const solved = !!secretWord && submittedGuesses.includes(secretWord);
                    noticeEl.textContent = solved
                        ? "🎉 풀이 완료! 아래에서 다른 참가자들을 관전하며 기다려 보세요."
                        : (timedOut
                            ? "⏰ 시간 초과! 정답을 확인하고 다른 참가자들을 관전해 보세요."
                            : "😢 아쉽게 실패! 정답을 확인하고 다른 참가자들을 관전해 보세요.");
                } else {
                    noticeEl.classList.add('hidden');
                }
                submitBtn.textContent = "제출";
                submitBtn.className = "key flex-[2] py-3 bg-emerald-600 text-white font-bold";
            }
        }

        function renderTimeSelector() {
            const min = (TIME_ATTACK_SEC[wordLength] || 0) / 60;
            const opts = [['attack', `⏱ 타임어택 · ${min}분`], ['free', '♾️ 무제한']];
            document.getElementById('timeSelector').innerHTML = opts.map(([mode, label]) =>
                `<button onclick="setTimeMode('${mode}')" class="py-2 rounded-lg border text-xs font-bold transition ${selectedTimeMode === mode ? 'bg-amber-500 border-amber-500 text-white' : 'bg-white border-amber-200 text-amber-700 hover:bg-amber-50'}">${label}</button>`
            ).join('');
        }

        function setTimeMode(mode) {
            if (hasMasterSetWord) return;
            selectedTimeMode = mode;
            renderTimeSelector();
        }

        // 풀이를 마친 참가자(성공/실패/시간초과)만 정답을 볼 수 있어요
        function canSeeAnswer() {
            return !!currentRoomCode && !isMaster && !isSpectator && isGameOver && !!secretWord;
        }

        function renderAnswerReveal() {
            const el = document.getElementById('answerReveal');
            if (!canSeeAnswer()) { el.classList.add('hidden'); return; }
            document.getElementById('answerTiles').innerHTML = secretWord.split('').map(c =>
                `<div class="w-7 h-7 rounded-md bg-amber-400 text-white font-bold flex items-center justify-center text-sm">${escapeHtml(c)}</div>`).join('');
            document.getElementById('answerWord').textContent = assemblePreview(secretWord);
            el.classList.remove('hidden');
        }

        function escapeHtml(str) {
            return String(str == null ? '' : str)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function renderSpectatorChips(players) {
            const chipsEl = document.getElementById('spectatorChips');
            const spectators = Object.entries(players).filter(([uid, p]) => p.spectator);
            if (spectators.length === 0) {
                chipsEl.innerHTML = '';
                chipsEl.style.display = 'none';
                return;
            }
            chipsEl.innerHTML = spectators.map(([uid, p]) => {
                const me = (uid === myUid) ? ' <span class="text-slate-400">(나)</span>' : '';
                return `<span class="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 text-[11px] font-semibold">👀 ${crown(uid)}${escapeHtml(p.nickname)}${me}<span class="ml-1 text-slate-500 font-normal">${p.waiting ? '다음 판부터 참여' : '관전 중'}</span></span>`;
            }).join('');
            chipsEl.style.display = 'flex';
        }

        function updateSpectatorBoard(players, masterUid) {
            const listEl = document.getElementById('playerStatusList');
            const titleEl = document.getElementById('spectatorTitle');
            listEl.innerHTML = '';
            renderSpectatorChips(players);
            renderAnswerReveal();
            renderForceBar(players, masterUid);
            const avOf = p => avatarHtml(sanitizeAv(p.avatar), 32);

            if (isMaster || canSeeDetail()) {
                titleEl.textContent = isMaster
                    ? "👁️ [출제자용] 참가자 입력 상세 관전 보드"
                    : (isSpectator ? "👁️ [관전자용] 참가자 입력 상세 관전 보드" : "👁️ [풀이 완료] 참가자 입력 상세 관전 보드");
                for (const [uid, p] of Object.entries(players)) {
                    if (uid === myUid || p.spectator) continue;
                    if (!isMaster && uid === masterUid) continue;
                    const div = document.createElement('div');
                    div.className = 'bg-white p-2.5 rounded-lg border border-slate-200 space-y-1';

                    const status = !p.completed ? `<span class="${activityInfo(p).cls} font-semibold">${activityInfo(p).label}</span>` : p.timedOut ? '<span class="text-rose-500 font-semibold">시간 초과</span>'
                        : (p.completed ? '<span class="text-emerald-600 font-semibold">풀이 완료</span>' : '<span class="text-amber-500">풀이 중...</span>');
                    let rowsHtml = `<div class="font-bold text-xs text-slate-700 flex justify-between items-center"><span class="flex items-center gap-1.5 mt-1">${avOf(p)}${nameHtml(uid, p.nickname)}</span> <span class="flex items-center gap-2">${status}${forceBtnFor(uid, p, masterUid)}</span></div>`;
                    rowsHtml += '<div class="space-y-1">';

                    const pGuesses = toArr(p.guesses);
                    for (let i = 0; i < maxGuesses; i++) {
                        const g = pGuesses[i] || "";
                        const evalRes = evaluateGuess(g, secretWord);
                        rowsHtml += '<div class="flex space-x-1">';
                        for (let j = 0; j < wordLength; j++) {
                            const char = g[j] || "";
                            let tileColor = 'bg-slate-50 border-slate-200 text-slate-400';
                            if (char && secretWord) {
                                if (evalRes[j] === 'correct') tileColor = 'bg-emerald-400 border-emerald-400 text-white font-bold';
                                else if (evalRes[j] === 'present') tileColor = 'bg-amber-400 border-amber-400 text-white font-bold';
                                else tileColor = 'bg-slate-400 border-slate-400 text-white font-bold';
                            }
                            rowsHtml += `<div class="w-5 h-5 border rounded flex items-center justify-center text-[10px] ${tileColor}">${escapeHtml(char)}</div>`;
                        }
                        rowsHtml += '</div>';
                    }
                    rowsHtml += '</div>';
                    div.innerHTML = rowsHtml;
                    listEl.appendChild(div);
                }
            } else {
                titleEl.textContent = "👁️ 실시간 참가자 현황 관전 보드";
                for (const [uid, p] of Object.entries(players)) {
                    if (uid === myUid || p.spectator) continue;
                    const div = document.createElement('div');
                    div.className = 'bg-white p-2 rounded-lg border border-slate-100 flex items-center justify-between text-xs';

                    let miniGridHtml = '<div class="flex space-x-1">';
                    const pGuesses = toArr(p.guesses);
                    for (let i = 0; i < maxGuesses; i++) {
                        const g = pGuesses[i] || "";
                        let colorClass = 'bg-slate-100 border border-slate-200';
                        if (g) {
                            if (g === secretWord) colorClass = 'bg-emerald-400';
                            else colorClass = 'bg-amber-400';
                        }
                        miniGridHtml += `<div class="w-4 h-4 rounded ${colorClass}"></div>`;
                    }
                    miniGridHtml += '</div>';

                    div.innerHTML = `<span class="font-bold text-slate-700 flex items-center gap-1.5 mt-1">${avOf(p)}${nameHtml(uid, p.nickname)}</span> <span class="flex items-center gap-2"><span class="${activityInfo(p).cls} text-[10px]">${activityInfo(p).label}</span>${miniGridHtml}${forceBtnFor(uid, p, masterUid)}</span>`;
                    listEl.appendChild(div);
                }
            }

            if (canSeeDetail() && listEl.children.length === 0) {
                listEl.innerHTML = '<p class="text-xs text-slate-400 text-center py-6">아직 문제를 푸는 참가자가 없어요. 잠시만 기다려주세요!</p>';
            }
            applyLeaderStyles();
        }

        function showResultsModal(data) {
            const rs = calcRoundScores(data);
            const list = Object.entries(data.players)
                .filter(([uid, p]) => uid !== data.masterUid && !p.spectator)
                .map(([uid, p]) => {
                    const g = toArr(p.guesses);
                    const solved = g.includes(data.secretWord);
                    return {
                        uid, nickname: p.nickname, avatar: p.avatar, solved,
                        attempts: solved ? g.indexOf(data.secretWord) + 1 : 99,
                        timestamp: p.solvedTimestamp || 9999999999999,
                        timedOut: !!p.timedOut,
                        pts: (rs[uid] && rs[uid].total) || 0
                    };
                });

            list.sort((a, b) => {
                if (a.solved && !b.solved) return -1;
                if (!a.solved && b.solved) return 1;
                if (a.attempts !== b.attempts) return a.attempts - b.attempts;
                return a.timestamp - b.timestamp;
            });

            document.getElementById('gameOverTitle').textContent = "🏆 라운드 결과지";
            const descEl = document.getElementById('gameOverDesc');

            const readableWord = assemblePreview(data.secretWord);
            let html = '';
            if (list[0] && list[0].solved) {
                const w0 = list[0];
                html += `<div class="flex flex-col items-center mb-3 pt-4"><div class="mb-1">${avatarHtml(sanitizeAv(w0.avatar), 72, true)}</div><p class="text-[11px] text-amber-600 font-bold mt-2">🏅 이번 라운드 1등</p><p class="text-base font-black text-slate-800">${nameHtml(w0.uid, w0.nickname)}</p></div>`;
            }
            html += `<p class="text-xs text-slate-500 mb-3">정답: <span class="font-bold text-emerald-600">[ ${escapeHtml(data.secretWord)}${readableWord ? ' (' + escapeHtml(readableWord) + ')' : ''} ]</span></p>`;
            html += `<div class="space-y-1.5 text-left max-h-44 overflow-y-auto mb-3">`;

            list.forEach((p, idx) => {
                const rankText = idx === 0 && p.solved ? "👑" : `${idx + 1}위`;
                const statusText = p.solved ? `${p.attempts}회 정답 🎉` : (p.timedOut ? '시간 초과 ⏰' : '실패 😢');
                html += `
                    <div class="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-50 border border-slate-100 text-xs">
                        <span class="font-bold text-slate-700 flex items-center gap-1.5 mt-1 min-w-0"><span class="shrink-0">${rankText}</span>${avatarHtml(sanitizeAv(p.avatar), 32)}${nameHtml(p.uid, p.nickname)}</span>
                        <span class="shrink-0 ${p.solved ? 'text-emerald-600 font-semibold' : 'text-slate-400'}">${statusText} <b class="${p.pts > 0 ? 'text-amber-600' : ''}">+${p.pts}</b></span>
                    </div>`;
            });
            const mRs = rs[data.masterUid];
            if (mRs && mRs.master) {
                const mp = data.players[data.masterUid];
                html += `<div class="flex items-center justify-between p-2 rounded-lg bg-amber-50 border border-amber-100 text-xs">
                    <span class="font-bold text-amber-700 flex items-center gap-1.5 mt-1">🎯 출제자 ${avatarHtml(sanitizeAv(mp && mp.avatar), 32)}${nameHtml(data.masterUid, mp ? mp.nickname : '')}</span>
                    <span class="text-amber-700 font-semibold">난이도 보너스 <b>+${mRs.master}</b></span></div>`;
            }
            html += `</div>`;

            const my = rs[myUid];
            if (my) {
                const parts = my.role === 'master' ? [`출제 보너스 +${my.master}`] :
                    [`기본 ${my.base}`, my.speed ? `스피드 +${my.speed}` : '', my.time ? `시간 +${my.time}` : '', my.hint ? `힌트 -${my.hint}` : ''].filter(Boolean);
                html += `<p class="text-[11px] text-slate-500 mb-2">내 점수 <b class="text-amber-600">+${my.total}</b> (${parts.join(' · ')}) <button onclick="openScoreHelp()" class="underline text-slate-400">점수 규칙</button></p>`;
            }

            const st = withRanks(getStandings(data)).slice(0, 8);
            html += `<p class="text-xs font-black text-slate-700 text-left mb-1">📊 누적 순위 <span class="font-medium text-slate-400">(이번 라운드 반영)</span></p><div class="space-y-1 text-left max-h-36 overflow-y-auto mb-4">`;
            st.forEach(x => {
                html += `<div class="flex items-center justify-between p-1.5 rounded-lg ${x.uid === myUid ? 'bg-emerald-50' : 'bg-white'} border border-slate-100 text-xs">
                    <span class="flex items-center gap-1.5 mt-1"><span class="w-5 text-center font-black">${x.total > 0 ? rankMedal(x.rank) : x.rank}</span>${avatarHtml(sanitizeAv(x.avatar), 30)}${nameHtml(x.uid, x.nickname)}</span>
                    <span class="font-black tabular-nums">${x.total}점</span></div>`;
            });
            html += `</div>`;

            const earned = my ? my.total : 0;
            if (earned > 0) {
                const key = `${currentRoomCode}:${data.round || 1}:${data.secretWord}`;
                if (awardCoinsOnce(key, earned)) html += `<p class="text-sm font-black text-amber-600 mb-3 -mt-1">🪙 코인 +${earned} 획득!</p>`;
            }
            descEl.innerHTML = html;
            applyLeaderStyles();

            const actionContainer = document.getElementById('gameOverActionContainer');
            actionContainer.innerHTML = '';

            if (isMaster || isHost) {
                const btn = document.createElement('button');
                btn.className = 'w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl transition shadow-sm';
                btn.textContent = isMaster ? '다음 라운드 진행' : '다음 라운드 진행 (방장)';
                btn.onclick = nextRound;
                actionContainer.appendChild(btn);
            } else {
                const notice = document.createElement('p');
                notice.className = 'text-xs text-amber-600 font-semibold py-2';
                notice.textContent = '⏳ 출제자가 다음 라운드를 진행하기를 기다리는 중입니다...';
                actionContainer.appendChild(notice);

                if (isSpectator) {
                    const closeBtn = document.createElement('button');
                    closeBtn.className = 'w-full mt-2 py-2.5 bg-slate-600 hover:bg-slate-700 text-white font-bold rounded-xl transition shadow-sm';
                    closeBtn.textContent = '닫고 관전 보드 보기';
                    closeBtn.onclick = () => document.getElementById('gameOverModal').classList.add('hidden');
                    actionContainer.appendChild(closeBtn);
                }
            }

            document.getElementById('gameOverModal').classList.remove('hidden');
        }

        // commitScores = true 이면 방금 끝난 라운드 점수를 누적 점수에 반영 (정상적인 '다음 라운드'일 때만)
        function startRound(data, nextMasterUid, commitScores, extra) {
            if (!db || !currentRoomCode || !data || !data.players || !data.players[nextMasterUid]) return;
            const roundScores = commitScores ? calcRoundScores(data) : {};
            const updates = {
                secretWord: "",
                masterUid: nextMasterUid,
                masterName: data.players[nextMasterUid].nickname,
                hintState: null,
                timeLimit: null,
                startedAt: null,
                left: null
            };
            Object.keys(data.players).forEach(uid => {
                const p = data.players[uid];
                const willPlay = !p.spectator || !!p.waiting;
                updates[`players/${uid}/guesses`] = [];
                updates[`players/${uid}/completed`] = (uid === nextMasterUid) || !willPlay;
                updates[`players/${uid}/solvedTimestamp`] = 0;
                updates[`players/${uid}/timedOut`] = null;
                if (commitScores && roundScores[uid]) updates[`players/${uid}/score`] = (p.score || 0) + roundScores[uid].total;
                if (p.waiting) {
                    updates[`players/${uid}/spectator`] = false;
                    updates[`players/${uid}/waiting`] = null;
                }
            });
            if (extra) Object.assign(updates, extra);
            db.ref(`rooms/${currentRoomCode}`).update(updates);
        }

        function nextRound() {
            if (!isMaster && !isHost) return;
            document.getElementById('gameOverModal').classList.add('hidden');
            if (!db || !currentRoomCode) return;
            db.ref(`rooms/${currentRoomCode}`).once('value', snapshot => {
                const data = snapshot.val();
                if (!data || !data.players) return;
                const eligible = Object.keys(data.players).filter(uid => !data.players[uid].spectator);
                if (eligible.length === 0) return;
                const currentIndex = eligible.indexOf(data.masterUid);
                const nextMasterUid = eligible[(currentIndex + 1) % eligible.length];
                const expected = data.round || 1;
                db.ref(`rooms/${currentRoomCode}/round`).transaction(
                    cur => (cur === null) ? expected + 1 : (cur === expected ? expected + 1 : undefined),
                    (err, committed) => { if (committed) startRound(data, nextMasterUid, true); }
                );
            });
        }

        function resetGameData(opts) {
            currentGuess = "";
            submittedGuesses = [];
            keyboardState = {};
            isGameOver = false;
            isResultsShown = false;
            solvedTimestamp = null;
            timedOut = false;
            makerWord = "";
            hasMasterSetWord = false;
            document.getElementById('gameOverModal').classList.add('hidden');
            initBoard();
            renderBoard();
            if (!(opts && opts.skipSync)) syncMyProgress();
            updateHintButton();
        }

        // ═══════════════════════════════════════════════════════════════
        //  방 화면 공통 갱신 (방장 표시 / 방 관리·힌트 버튼 / 힌트 UI)
        // ═══════════════════════════════════════════════════════════════
        function updateRoomChrome(data) {
            const hostP = (data.players || {})[data.hostUid];
            document.getElementById('dispHostRow').classList.toggle('hidden', !data.hostUid);
            document.getElementById('dispHost').textContent = '👑 ' + (hostP ? hostP.nickname : (data.hostName || '알 수 없음'));

            if (!document.getElementById('hostModal').classList.contains('hidden')) renderHostPanel();
            handleHintState(data);
        }

        // ═══════════════════════════════════════════════════════════════
        //  방장 기능: 강퇴 / 출제자 변경
        // ═══════════════════════════════════════════════════════════════
        function openHostModal() {
            if (!isHost) return;
            renderHostPanel();
            document.getElementById('hostModal').classList.remove('hidden');
        }

        function closeHostModal() {
            document.getElementById('hostModal').classList.add('hidden');
        }

        function renderHostPanel() {
            const listEl = document.getElementById('hostPlayerList');
            const data = lastRoomData;
            if (!data || !data.players) { listEl.innerHTML = ''; return; }
            listEl.innerHTML = Object.entries(data.players).map(([uid, p]) => {
                const isSelf = uid === myUid;
                const isCurMaster = uid === data.masterUid;
                const badges =
                    (isCurMaster ? '<span class="ml-1 text-[10px] font-semibold text-emerald-600">출제자</span>' : '') +
                    (p.spectator ? `<span class="ml-1 text-[10px] font-semibold text-slate-500">${p.waiting ? '다음 판부터 참여' : '관전'}</span>` : '') +
                    (isSelf ? '<span class="ml-1 text-[10px] text-slate-400">(나)</span>' : '') +
                    `<span class="ml-1 text-[10px] ${activityInfo(p).cls}">${activityInfo(p).label}</span>`;
                let btns = '';
                if (!p.spectator && !isCurMaster) {
                    btns += `<button data-uid="${escapeHtml(uid)}" onclick="hostSetMaster(this.dataset.uid)" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold rounded-md">출제자 지정</button>`;
                }
                if (!p.spectator && !isCurMaster && !p.completed && data.secretWord && !protectedSolver(p)) {
                    btns += `<button data-uid="${escapeHtml(uid)}" onclick="forceSpectate(this.dataset.uid)" class="px-2 py-1 bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-bold rounded-md">관전 전환</button>`;
                }
                if (!isSelf) {
                    btns += `<button data-uid="${escapeHtml(uid)}" onclick="hostKick(this.dataset.uid)" class="px-2 py-1 bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-bold rounded-md">강퇴</button>`;
                }
                return `<div class="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-slate-200 bg-slate-50">
                    <div class="text-sm font-bold text-slate-700 truncate">${crown(uid)}${escapeHtml(p.nickname)}${badges}</div>
                    <div class="flex gap-1 shrink-0">${btns}</div>
                </div>`;
            }).join('');
        }

        function hostKick(uid) {
            if (!isHost || !db || !currentRoomCode || !lastRoomData) return;
            if (uid === myUid) return;
            const target = (lastRoomData.players || {})[uid];
            if (uid === lastRoomData.masterUid) {
                showToast("현재 출제자는 강퇴할 수 없어요. 먼저 출제자를 변경해주세요.");
                return;
            }
            const p = (lastRoomData.players || {})[uid];
            const activeWarning = protectedSolver(p) ? '\n\n⚠️ 현재 접속 중이며 문제를 풀고 있는 참가자입니다. 정말 강퇴할까요?' : '';
            if (!confirm(`${p ? p.nickname : '이 사용자'}님을 방에서 내보낼까요?\n(방 코드를 입력하면 다시 들어올 수 있어요.)${activeWarning}`)) return;
            db.ref(`rooms/${currentRoomCode}`).update({
                [`players/${uid}`]: null,
                [`scoreArchive/${uid}`]: (p && (p.score || 0) > 0) ? { nickname: p.nickname, score: p.score } : null,
                [`kicked/${uid}`]: true
            });
            showToast("방에서 내보냈어요.");
        }

        function hostResetScores() {
            if (!isHost || !db || !currentRoomCode || !lastRoomData || !lastRoomData.players) return;
            if (!confirm('모든 참가자의 누적 점수를 0점으로 초기화할까요?')) return;
            const ups = { scoreArchive: null };
            Object.keys(lastRoomData.players).forEach(u => { ups[`players/${u}/score`] = 0; });
            db.ref(`rooms/${currentRoomCode}`).update(ups);
            showToast('누적 점수를 초기화했어요.');
        }

        function hostSetMaster(uid) {
            if (!isHost || !db || !currentRoomCode || !lastRoomData || !lastRoomData.players) return;
            const p = lastRoomData.players[uid];
            if (!p || p.spectator || uid === lastRoomData.masterUid) return;
            if (!confirm(`출제자를 ${p.nickname}님으로 변경할까요?\n이번 라운드는 처음부터 다시 시작됩니다.`)) return;
            startRound(lastRoomData, uid, false);
            closeHostModal();
            showToast("출제자를 변경했습니다.");
        }

        function handleKicked(reason) {
            if (db && currentRoomCode && roomDataListener) {
                db.ref(`rooms/${currentRoomCode}`).off('value', roomDataListener);
            }
            roomDataListener = null;
            leaveRoomLocal();
            alert(reason === 'takeover'
                ? "같은 닉네임으로 다른 화면에서 다시 접속해서, 이 화면은 방에서 나가게 되었어요."
                : "방장이 진행을 위해 방에서 내보냈어요. 필요하면 방 코드로 다시 입장할 수 있어요.");
        }

        function leaveRoomLocal() {
            cleanupChat(currentRoomCode); // [업그레이드 3] 채팅방 정리
            stopTimerLoop();
            stopActivityHeartbeat();
            timedOut = false; timeUpKey = null;
            leaderUids = new Set(); leaderInit = false; myPrevRank = null;
            ['shopModal', 'casinoModal', 'scoreHelpModal'].forEach(id => document.getElementById(id).classList.add('hidden'));
            currentRoomCode = null;
            isMaster = false; isSpectator = false; isHost = false;
            hostUid = null; lastRoomData = null; secretWord = "";
            if (hintTimer) { clearInterval(hintTimer); hintTimer = null; }
            ['hintModal', 'hostModal', 'gameOverModal', 'hintBanner', 'hintBar', 'multiplayerInfo', 'spectatorDashboard', 'timerRow', 'rankPanel', 'timeSelectorRow', 'answerReveal', 'forceBar']
                .forEach(id => document.getElementById(id).classList.add('hidden'));
            document.getElementById('board').classList.remove('hidden');
            document.getElementById('keyboard').classList.remove('hidden');
            document.getElementById('gameModeBadge').textContent = "혼자 하기";
            document.getElementById('roomBtnText').textContent = "대결 방";
            resetGameData();
        }

        // ═══════════════════════════════════════════════════════════════
        //  힌트 투표
        // ═══════════════════════════════════════════════════════════════
        function getHintState() {
            return (lastRoomData && lastRoomData.hintState) || {};
        }

        function getRevealedIndexes(hs) {
            return Object.keys((hs && hs.revealed) || {})
                .map(k => parseInt(k.slice(1), 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
        }

        function activeVoterUids(sess) {
            const present = (lastRoomData && lastRoomData.players) || {};
            return Object.keys((sess && sess.voters) || {}).filter(u => present[u] && !present[u].spectator);
        }

        function isHintOpen() {
            const sess = getHintState().session;
            return !!sess && sess.status === 'open';
        }

        function isHintCooling(hs) {
            return !!hs.lastEnd && (serverNow() - hs.lastEnd) < HINT_COOLDOWN_SECONDS * 1000;
        }

        function updateHintButton() {
            const btn = document.getElementById('hintReqBtn');
            const hostBtn = document.getElementById('hostBtn');
            const wrap = document.getElementById('roomActions');

            const show = !!currentRoomCode && !isMaster && !isSpectator && !isGameOver && !!secretWord;
            btn.classList.toggle('hidden', !show);
            if (show) {
                const hs = getHintState();
                const left = MAX_HINTS_PER_ROUND - getRevealedIndexes(hs).length;
                let enabled = true;
                let label = `💡 힌트 요청 (남은 ${left}회)`;
                if (left <= 0) { enabled = false; label = '💡 힌트를 모두 사용했어요'; }
                else if (isHintOpen()) { enabled = false; label = '💡 투표 진행 중...'; }
                else if (isHintCooling(hs)) {
                    const sec = Math.ceil((HINT_COOLDOWN_SECONDS * 1000 - (serverNow() - hs.lastEnd)) / 1000);
                    enabled = false; label = `💡 ${sec}초 후 요청 가능`;
                }
                btn.textContent = label;
                btn.disabled = !enabled;
                btn.className = 'px-3 py-1.5 text-white text-xs font-bold rounded-lg transition ' +
                    (enabled ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-slate-400 pointer-events-none');
            }
            hostBtn.classList.toggle('hidden', !isHost);
            wrap.classList.toggle('hidden', !currentRoomCode);
            updateSpectateBtn();
        }

        function renderHintBar(data) {
            const bar = document.getElementById('hintBar');
            const rev = getRevealedIndexes(data.hintState || {});
            if (rev.length === 0 || !data.secretWord) { bar.classList.add('hidden'); return; }
            let html = '<span class="text-xs font-bold text-indigo-700 mr-1">💡 힌트</span>';
            for (let i = 0; i < wordLength; i++) {
                const show = rev.includes(i);
                html += `<div class="w-7 h-7 rounded-md border flex items-center justify-center text-sm font-bold ${show ? 'bg-indigo-100 border-indigo-300 text-indigo-800' : 'bg-white border-slate-200 text-slate-300'}">${show ? escapeHtml(data.secretWord[i] || '') : '?'}</div>`;
            }
            bar.innerHTML = html;
            bar.classList.remove('hidden');
        }

        function requestHint() {
            const hs = getHintState();
            if (!db || !currentRoomCode || !lastRoomData || isMaster || isSpectator || isGameOver || !secretWord) return;
            if (isHintOpen()) { showToast("이미 힌트 투표가 진행 중이에요."); return; }
            if (getRevealedIndexes(hs).length >= MAX_HINTS_PER_ROUND) { showToast("이번 라운드 힌트를 모두 사용했어요."); return; }
            if (isHintCooling(hs)) { showToast("잠시 후에 다시 요청할 수 있어요."); return; }

            const voters = {};
            Object.entries(lastRoomData.players || {}).forEach(([uid, p]) => {
                if (uid !== lastRoomData.masterUid && !p.spectator && !p.completed) voters[uid] = true;
            });
            if (Object.keys(voters).length === 0) return;

            const id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            db.ref(`rooms/${currentRoomCode}/hintState`).transaction(cur => {
                cur = cur || {};
                if (cur.session && cur.session.status === 'open') return;
                if (Object.keys(cur.revealed || {}).length >= MAX_HINTS_PER_ROUND) return;
                cur.session = {
                    id, requesterUid: myUid, requesterName: myNickname, voters,
                    deadline: serverNow() + HINT_VOTE_SECONDS * 1000, status: 'open'
                };
                return cur;
            }, (err, committed) => {
                if (!committed) showToast("이미 진행 중인 힌트 투표가 있어요.");
            });
        }

        function castHintVote(v) {
            if (!db || !currentRoomCode) return;
            const hs = getHintState();
            const sess = hs.session;
            if (!sess || sess.status !== 'open' || !sess.voters || !sess.voters[myUid]) return;
            if (v >= 0 && (hs.revealed || {})['p' + v]) return;
            db.ref(`rooms/${currentRoomCode}/hintState/session/votes/${myUid}`).set(v);
        }

        function tryResolveHint() {
            const sess = getHintState().session;
            if (!db || !currentRoomCode || !sess || sess.status !== 'open') return;
            const votes = sess.votes || {};
            const active = activeVoterUids(sess);
            const allVoted = active.length === 0 || active.every(u => votes[u] !== undefined);
            if (!(allVoted || serverNow() >= sess.deadline)) return;

            db.ref(`rooms/${currentRoomCode}/hintState`).transaction(cur => {
                if (!cur) return cur;
                if (!cur.session || cur.session.id !== sess.id || cur.session.status !== 'open') return;
                const s = cur.session;
                const vs = s.voters || {};
                const vt = s.votes || {};
                const revealed = cur.revealed || {};
                let approve = 0, reject = 0;
                const tally = {};
                Object.keys(vs).forEach(u => {
                    const v = vt[u];
                    if (v === undefined || v === null) return;
                    if (v === -1) reject++;
                    else if (!revealed['p' + v]) { approve++; tally[v] = (tally[v] || 0) + 1; }
                });
                let result;
                if (approve + reject === 0) result = { type: 'none' };
                else if (reject >= approve) result = { type: 'reject' };
                else {
                    let bestCnt = 0;
                    Object.keys(tally).forEach(k => { bestCnt = Math.max(bestCnt, tally[k]); });
                    const tied = Object.keys(tally).map(Number).filter(i => tally[i] === bestCnt);
                    const best = tied[Math.floor(Math.random() * tied.length)];   // 동점이면 랜덤
                    result = { type: 'reveal', index: best, tie: tied.length > 1 };
                    cur.revealed = cur.revealed || {};
                    cur.revealed['p' + best] = true;
                }
                result.approve = approve; result.reject = reject;
                s.status = 'done';
                s.result = result;
                cur.lastEnd = serverNow();
                return cur;
            });
        }

        function setHintBanner(text, ms) {
            const b = document.getElementById('hintBanner');
            b.textContent = text;
            b.classList.remove('hidden');
            clearTimeout(hintBannerTimer);
            if (ms) hintBannerTimer = setTimeout(() => { if (!isHintOpen()) b.classList.add('hidden'); }, ms);
        }

        function announceHintResult(sess) {
            if (lastAnnouncedHintId === sess.id) return;
            lastAnnouncedHintId = sess.id;
            const r = sess.result || { type: 'none' };
            let text;
            if (r.type === 'reveal') {
                text = `💡 ${r.index + 1}번째 자리 '${secretWord[r.index] || '?'}' 공개! (찬성 ${r.approve} · 거절 ${r.reject})${r.tie ? ' 🎲 동점이라 랜덤으로 뽑았어요!' : ''}`;
            } else if (r.type === 'reject') {
                text = `🙅 힌트 요청이 거절됐어요 (찬성 ${r.approve} · 거절 ${r.reject})`;
            } else {
                text = '⌛ 투표가 없어 힌트가 공개되지 않았어요.';
            }
            showToast(text);
            setHintBanner(text, 8000);
        }

        function ensureHintTimer() {
            if (hintTimer) return;
            hintTimer = setInterval(() => {
                const hs = getHintState();
                const open = isHintOpen();
                if (open) { tryResolveHint(); renderHintVoteUI(); }
                updateHintButton();
                if (!open && !isHintCooling(hs)) { clearInterval(hintTimer); hintTimer = null; }
            }, 1000);
        }

        function handleHintState(data) {
            const hs = data.hintState || {};
            const sess = hs.session || null;
            if (!hintInitDone) {
                hintInitDone = true;
                if (sess && sess.status === 'done') lastAnnouncedHintId = sess.id;
            }
            renderHintBar(data);
            updateHintButton();

            if (sess && sess.status === 'open') {
                ensureHintTimer();
                renderHintVoteUI();
                tryResolveHint();
            } else {
                document.getElementById('hintModal').classList.add('hidden');
                if (sess && sess.status === 'done') {
                    announceHintResult(sess);
                    if (isHintCooling(hs)) ensureHintTimer();
                } else {
                    document.getElementById('hintBanner').classList.add('hidden');
                }
            }
        }

        function dismissHintModal() {
            const sess = getHintState().session;
            if (sess) hintModalDismissedId = sess.id;
            document.getElementById('hintModal').classList.add('hidden');
        }

        function reopenHintModal() {
            hintModalDismissedId = null;
            renderHintVoteUI();
        }

        function renderHintVoteUI() {
            const hs = getHintState();
            const sess = hs.session;
            if (!sess || sess.status !== 'open') return;

            const voters = Object.keys(sess.voters || {});
            const votes = sess.votes || {};
            const active = activeVoterUids(sess);
            const voted = active.filter(u => votes[u] !== undefined).length;
            const remain = Math.max(0, Math.ceil((sess.deadline - serverNow()) / 1000));
            const amVoter = !!(sess.voters && sess.voters[myUid]) && !isMaster && !isSpectator;

            const banner = document.getElementById('hintBanner');
            banner.classList.remove('hidden');
            banner.textContent = `💡 ${sess.requesterName}님이 힌트를 요청했어요 · 투표 ${voted}/${active.length}명 · ${remain}초` +
                (amVoter && hintModalDismissedId === sess.id ? ' (탭해서 투표하기)' : '');

            const modal = document.getElementById('hintModal');
            if (!amVoter || hintModalDismissedId === sess.id) { modal.classList.add('hidden'); return; }
            modal.classList.remove('hidden');

            document.getElementById('hintModalDesc').textContent =
                `${sess.requesterName}님이 힌트를 요청했어요. 공개하고 싶은 자리에 투표하거나 거절하세요. 거절표가 같거나 더 많으면 공개되지 않아요.`;
            document.getElementById('hintModalStatus').textContent = `투표 ${voted}/${active.length}명 · 남은 시간 ${remain}초`;

            const revealed = hs.revealed || {};
            const sig = JSON.stringify([sess.id, votes, revealed, wordLength]);
            if (sig === hintRenderSig) return;
            hintRenderSig = sig;

            const myVote = votes[myUid];
            const counts = {};
            let rejectCnt = 0;
            voters.forEach(u => {
                const v = votes[u];
                if (v === undefined) return;
                if (v === -1) rejectCnt++; else counts[v] = (counts[v] || 0) + 1;
            });
            let html = '<div class="grid grid-cols-4 gap-2">';
            for (let i = 0; i < wordLength; i++) {
                if (revealed['p' + i]) {
                    html += `<div class="py-2 rounded-xl border border-slate-200 bg-slate-100 text-slate-400 text-center text-xs font-bold">${i + 1}번째<br><span class="text-[10px]">공개됨</span></div>`;
                } else {
                    const mine = myVote === i;
                    html += `<button onclick="castHintVote(${i})" class="py-2 rounded-xl border text-xs font-bold transition ${mine ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-300 text-slate-700 hover:bg-indigo-50'}">${i + 1}번째<br><span class="text-[10px] font-semibold">${counts[i] || 0}표</span></button>`;
                }
            }
            html += '</div>';
            html += `<button onclick="castHintVote(-1)" class="w-full mt-3 py-2.5 rounded-xl border text-sm font-bold transition ${myVote === -1 ? 'bg-rose-600 border-rose-600 text-white' : 'bg-white border-rose-300 text-rose-600 hover:bg-rose-50'}">🙅 거절 (${rejectCnt}표)</button>`;
            document.getElementById('hintVoteControls').innerHTML = html;
        }

        // ═══════════════════════════════════════════════════════════════
        //  화면 갱신 보조 / 방 나가기
        // ═══════════════════════════════════════════════════════════════
        function canSeeDetail() {
            return isSpectator || (!!currentRoomCode && !isMaster && isGameOver);
        }

        function refreshRoomView() {
            toggleMasterUI();
            renderAnswerReveal();
            if (lastRoomData && lastRoomData.players) updateSpectatorBoard(lastRoomData.players, lastRoomData.masterUid);
        }

        function leaveRoom() {
            if (!db || !currentRoomCode) return;
            const data = lastRoomData;
            const players = (data && data.players) || {};
            const others = Object.keys(players).filter(u => u !== myUid);

            let msg = '방에서 나갈까요?';
            if (isMaster && others.length > 0) msg += '\n(출제자가 나가면 이번 라운드가 처음부터 다시 시작돼요.)';
            else if (!isSpectator && !isMaster && secretWord) msg += '\n(같은 닉네임으로 다시 들어오면 이어서 풀 수 있어요.)';
            if (!confirm(msg)) return;

            performLeave();
            showToast("방에서 나왔어요.");
        }

        function performLeave() {
            if (!db || !currentRoomCode) return;
            const code = currentRoomCode;
            const data = lastRoomData;
            const players = (data && data.players) || {};
            const others = Object.keys(players).filter(u => u !== myUid);
            const othersPlaying = others.filter(u => !players[u].spectator);
            const myScore = (players[myUid] && players[myUid].score) || 0;

            if (roomDataListener) db.ref(`rooms/${code}`).off('value', roomDataListener);
            roomDataListener = null;

            if (data) {
                if (others.length === 0) {
                    db.ref(`rooms/${code}`).remove();
                } else {
                    const updates = { [`players/${myUid}`]: null };
                    if (myScore > 0) updates[`scoreArchive/${myUid}`] = { nickname: myNickname, score: myScore };
                    if (!isSpectator && !isMaster) {
                        updates[`left/${myUid}`] = { nickname: myNickname, guesses: submittedGuesses, solvedTimestamp: solvedTimestamp || 0, score: myScore };
                    }
                    if (isHost) {
                        const newHost = othersPlaying[0] || others[0];
                        updates.hostUid = newHost;
                        updates.hostName = players[newHost].nickname;
                    }
                    if (isMaster) {
                        const cand = othersPlaying[0] || others[0];
                        const rest = JSON.parse(JSON.stringify(data));
                        delete rest.players[myUid];
                        if (players[cand].spectator) {
                            updates[`players/${cand}/spectator`] = false;
                            updates[`players/${cand}/waiting`] = null;
                        }
                        startRound(rest, cand, false, updates);
                    } else {
                        db.ref(`rooms/${code}`).update(updates);
                    }
                }
            }
            leaveRoomLocal();
        }

        // ═══════════════════════════════════════════════════════════════
        //  [업그레이드 3] 💬 실시간 채팅 기능 (최근 50개 유지, 서버비용 제로!)
        // ═══════════════════════════════════════════════════════════════
        let chatListener = null;
        let isChatOpen = false;
        let unreadChatCount = 0;
        let chatInitTime = 0;

        function initChat(roomCode) {
            document.getElementById('chatContainer').classList.remove('hidden');
            document.getElementById('chatMessages').innerHTML =
                '<p class="text-center text-slate-400 py-2">채팅방에 연결되었습니다. 매너 채팅 부탁드려요! 😊</p>';
            unreadChatCount = 0;
            updateChatBadge();
            chatInitTime = serverNow();

            if (chatListener) db.ref(`rooms/${roomCode}/chats`).off('child_added', chatListener);
            chatListener = db.ref(`rooms/${roomCode}/chats`).limitToLast(50).on('child_added', snap => {
                const msg = snap.val();
                if (!msg) return;
                appendChatMessage(msg);
                if (!isChatOpen && msg.uid !== myUid && (msg.ts || 0) > chatInitTime) {
                    unreadChatCount++;
                    updateChatBadge();
                }
            });
        }

        function cleanupChat(roomCode) {
            if (db && roomCode && chatListener) {
                db.ref(`rooms/${roomCode}/chats`).off('child_added', chatListener);
            }
            chatListener = null;
            isChatOpen = false;
            unreadChatCount = 0;
            document.getElementById('chatPanel').classList.add('hidden');
            document.getElementById('chatContainer').classList.add('hidden');
        }

        function toggleChat() {
            isChatOpen = !isChatOpen;
            const panel = document.getElementById('chatPanel');
            panel.classList.toggle('hidden', !isChatOpen);
            if (isChatOpen) {
                unreadChatCount = 0;
                updateChatBadge();
                const box = document.getElementById('chatMessages');
                box.scrollTop = box.scrollHeight;
                document.getElementById('chatInput').focus();
            }
        }

        function updateChatBadge() {
            const badge = document.getElementById('chatBadge');
            if (unreadChatCount > 0) {
                badge.textContent = unreadChatCount > 99 ? '99+' : unreadChatCount;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        }

        function sendChatMessage(e) {
            e.preventDefault();
            if (!db || !currentRoomCode) return;
            const input = document.getElementById('chatInput');
            const text = input.value.trim();
            if (!text) return;

            // 스포일러 방지: 정답 자모나 조합된 정답 단어가 채팅에 포함되면 전송 차단
            if (secretWord) {
                const answerWord = assemblePreview(secretWord);
                if (text.includes(secretWord) || (answerWord && text.includes(answerWord))) {
                    showToast("🤫 정답이 포함된 메시지는 보낼 수 없어요!");
                    input.value = '';
                    return;
                }
            }

            const chatRef = db.ref(`rooms/${currentRoomCode}/chats`);
            chatRef.push({
                uid: myUid,
                nickname: myNickname,
                av: myAvatar(),
                nameStyle:safeNameStyle(profile.eq.name),
                text: text,
                ts: serverNow()
            });
            input.value = '';

            // 50개가 넘어가면 가장 오래된 메시지 자동 삭제 (DB 용량 절약)
            chatRef.once('value', snap => {
                if (snap.numChildren() > 50) {
                    let count = snap.numChildren();
                    const updates = {};
                    snap.forEach(child => {
                        if (count > 50) {
                            updates[child.key] = null;
                            count--;
                        }
                    });
                    chatRef.update(updates);
                }
            });
        }

        function appendChatMessage(msg) {
            const box = document.getElementById('chatMessages');
            const isMe = (msg.uid === myUid);
            const div = document.createElement('div');
            div.className = `chat-msg flex items-end gap-1.5 mt-2 ${isMe ? 'flex-row-reverse' : ''}`;
            div.dataset.uid = msg.uid || '';
            div.innerHTML = `
                <div class="pt-3">${avatarHtml(sanitizeAv(msg.av), 40)}</div>
                <div class="flex flex-col min-w-0 ${isMe ? 'items-end' : 'items-start'}">
                    <span class="text-[10px] text-slate-400 mb-0.5 px-1">${nameHtml(msg.uid, msg.nickname, msg.nameStyle)}</span>
                    <div class="chat-bubble px-3 py-1.5 rounded-2xl max-w-[100%] break-words ${isMe ? 'bg-emerald-600 text-white rounded-br-none' : 'bg-white border border-slate-200 text-slate-700 rounded-bl-none shadow-sm'}">
                        ${escapeHtml(msg.text)}
                    </div>
                </div>
            `;
            box.appendChild(div);
            box.scrollTop = box.scrollHeight;
            applyLeaderStyles();
        }

        // ═══════════════════════════════════════════════════════════════
        //  PC 키보드 입력 (한글 두벌식 자판 위치 기준)
        // ═══════════════════════════════════════════════════════════════
        const KEY_TO_JAMO = {
            KeyQ: 'ㅂ', KeyW: 'ㅈ', KeyE: 'ㄷ', KeyR: 'ㄱ', KeyT: 'ㅅ', KeyY: 'ㅛ', KeyU: 'ㅕ', KeyI: 'ㅑ',
            KeyA: 'ㅁ', KeyS: 'ㄴ', KeyD: 'ㅇ', KeyF: 'ㄹ', KeyG: 'ㅎ', KeyH: 'ㅗ', KeyJ: 'ㅓ', KeyK: 'ㅏ', KeyL: 'ㅣ',
            KeyZ: 'ㅋ', KeyX: 'ㅌ', KeyC: 'ㅊ', KeyV: 'ㅍ', KeyB: 'ㅠ', KeyN: 'ㅜ', KeyM: 'ㅡ'
        };
        const KEY_TO_JAMO_SEQ = { KeyO: ['ㅏ', 'ㅣ'], KeyP: ['ㅓ', 'ㅣ'] };
        const SHIFT_KEY_SEQ = { KeyO: ['ㅑ', 'ㅣ'], KeyP: ['ㅕ', 'ㅣ'] };
        const SHIFT_DOUBLE = { KeyQ: 'ㅂ', KeyW: 'ㅈ', KeyE: 'ㄷ', KeyR: 'ㄱ', KeyT: 'ㅅ' };

        function jamoFromKeyEvent(code, shift) {
            if (shift) {
                if (SHIFT_KEY_SEQ[code]) return SHIFT_KEY_SEQ[code];
                if (SHIFT_DOUBLE[code]) return [SHIFT_DOUBLE[code], SHIFT_DOUBLE[code]];
            }
            if (KEY_TO_JAMO_SEQ[code]) return KEY_TO_JAMO_SEQ[code];
            if (KEY_TO_JAMO[code]) return [KEY_TO_JAMO[code]];
            return null;
        }

        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const t = e.target;
            const tag = t && t.tagName;
            // 채팅창이나 닉네임 입력칸에 타이핑 중일 때는 게임 키보드가 작동하지 않도록 보호
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
            if (['lobbyModal', 'hostModal', 'hintModal', 'gameOverModal', 'shopModal', 'casinoModal', 'scoreHelpModal'].some(id => !document.getElementById(id).classList.contains('hidden'))) return;

            if (e.key === 'Enter') {
                if (tag === 'BUTTON') return;
                e.preventDefault();
                handleSubmit();
                return;
            }
            if (e.key === 'Backspace') {
                e.preventDefault();
                handleDelete();
                return;
            }
            if (e.repeat) return;
            const seq = jamoFromKeyEvent(e.code, e.shiftKey);
            if (seq) {
                e.preventDefault();
                seq.forEach(handleKey);
            }
        });


        // ═══════════════════════════════════════════════════════════════
        //  🐾 캐릭터 / 코인 / 상점  (코인·보유 아이템은 이 기기(localStorage)에 저장돼요)
        // ═══════════════════════════════════════════════════════════════
        const AVATAR_BASES = [
            // 기본(무료)
            { id: '🐶', n: '강아지', p: 0 }, { id: '🐱', n: '고양이', p: 0 }, { id: '🐰', n: '토끼', p: 0 },
            { id: '🐻', n: '곰', p: 0 }, { id: '🐼', n: '판다', p: 0 }, { id: '🦊', n: '여우', p: 0 },
            { id: '🐧', n: '펭귄', p: 0 }, { id: '🐸', n: '개구리', p: 0 },
            { id: '🐭', n: '쥐', p: 100 }, { id: '🐹', n: '햄스터', p: 100 }, { id: '🐤', n: '병아리', p: 100 },
            { id: '🐮', n: '소', p: 150 }, { id: '🐷', n: '돼지', p: 150 }, { id: '🐵', n: '원숭이', p: 150 },
            { id: '🐔', n: '닭', p: 150 }, { id: '🐝', n: '꿀벌', p: 150 }, { id: '🐞', n: '무당벌레', p: 150 },
            { id: '🐯', n: '호랑이', p: 200 }, { id: '🦁', n: '사자', p: 200 }, { id: '🐨', n: '코알라', p: 200 },
            { id: '🦆', n: '오리', p: 200 }, { id: '🐢', n: '거북이', p: 200 }, { id: '🦋', n: '나비', p: 200 }, { id: '🐌', n: '달팽이', p: 200 },
            { id: '🦉', n: '부엉이', p: 250 }, { id: '🐴', n: '말', p: 250 }, { id: '🐗', n: '멧돼지', p: 250 },
            { id: '🦔', n: '고슴도치', p: 250 }, { id: '🐺', n: '늑대', p: 250 }, { id: '🦇', n: '박쥐', p: 250 },
            { id: '🐙', n: '문어', p: 300 }, { id: '🐬', n: '돌고래', p: 300 }, { id: '🦀', n: '게', p: 300 }, { id: '🐠', n: '열대어', p: 300 },
            { id: '🦒', n: '기린', p: 300 }, { id: '🦓', n: '얼룩말', p: 300 }, { id: '🐘', n: '코끼리', p: 300 }, { id: '🦘', n: '캥거루', p: 300 },
            { id: '🐳', n: '고래', p: 350 }, { id: '🐊', n: '악어', p: 350 }, { id: '🦅', n: '독수리', p: 350 },
            { id: '🦜', n: '앵무새', p: 350 }, { id: '🦛', n: '하마', p: 350 }, { id: '🦏', n: '코뿔소', p: 350 },
            { id: '🦈', n: '상어', p: 400 }, { id: '🦚', n: '공작새', p: 400 }, { id: '👻', n: '유령', p: 400 }, { id: '🎃', n: '호박', p: 400 },
            { id: '🦄', n: '유니콘', p: 500 }, { id: '👽', n: '외계인', p: 500 }, { id: '🤖', n: '로봇', p: 500 },
            { id: '🦖', n: '티라노', p: 600 }, { id: '🦕', n: '공룡', p: 600 },
            { id: '🐲', n: '용', p: 700 }, { id: '🐉', n: '드래곤', p: 800 }
        ];
        const SHOP_ITEMS = {
            hat: [
                { id: '🎀', n: '리본', p: 100 }, { id: '🧢', n: '야구모자', p: 150 }, { id: '🌸', n: '벚꽃', p: 150 }, { id: '🍀', n: '클로버', p: 150 },
                { id: '👒', n: '밀짚모자', p: 200 }, { id: '🎧', n: '헤드폰', p: 200 }, { id: '🍄', n: '버섯', p: 200 },
                { id: '⛑️', n: '구조모자', p: 250 }, { id: '🎩', n: '신사모자', p: 250 }, { id: '🌻', n: '해바라기', p: 250 }, { id: '🍉', n: '수박', p: 250 },
                { id: '🎓', n: '학사모', p: 300 }, { id: '⭐', n: '별', p: 300 },
                { id: '🔥', n: '불꽃', p: 400 }, { id: '🌈', n: '무지개', p: 400 }, { id: '👑', n: '왕관', p: 600 }
            ],
            face: [
                { id: '👓', n: '안경', p: 150 }, { id: '💖', n: '볼하트', p: 150 }, { id: '🕶️', n: '선글라스', p: 200 }, { id: '💋', n: '키스마크', p: 200 },
                { id: '🥽', n: '고글', p: 250 }, { id: '🌹', n: '귀에 꽂은 장미', p: 250 }, { id: '✨', n: '반짝이', p: 300 }, { id: '💫', n: '별빛', p: 400 }
            ],
            neck: [
                { id: '🎗️', n: '리본뱃지', p: 150 }, { id: '🧣', n: '목도리', p: 180 }, { id: '🔔', n: '방울', p: 200 }, { id: '👔', n: '넥타이', p: 200 },
                { id: '📿', n: '목걸이', p: 250 }, { id: '🌺', n: '꽃목걸이', p: 250 }, { id: '🔑', n: '열쇠', p: 250 },
                { id: '📷', n: '카메라', p: 300 }, { id: '🏅', n: '금메달', p: 350 }, { id: '🥇', n: '1등 메달', p: 400 }, { id: '💎', n: '보석', p: 400 }
            ],
            side: [
                { id: '🎈', n: '풍선', p: 100 }, { id: '🍦', n: '아이스크림', p: 120 }, { id: '🍩', n: '도넛', p: 120 }, { id: '🍔', n: '햄버거', p: 120 },
                { id: '⚽', n: '축구공', p: 150 }, { id: '🏀', n: '농구공', p: 150 }, { id: '📚', n: '책', p: 150 }, { id: '🌂', n: '우산', p: 150 },
                { id: '🎁', n: '선물', p: 200 }, { id: '🧸', n: '곰인형', p: 200 }, { id: '🎨', n: '팔레트', p: 200 }, { id: '🍰', n: '케이크', p: 200 },
                { id: '🎤', n: '마이크', p: 250 }, { id: '🎮', n: '게임기', p: 250 }, { id: '🎸', n: '기타', p: 300 }, { id: '🗡️', n: '검', p: 300 },
                { id: '🛡️', n: '방패', p: 350 }, { id: '🔮', n: '수정구슬', p: 400 }, { id: '🚀', n: '로켓', p: 500 }, { id: '🏆', n: '트로피', p: 500 }
            ],
            bg: [
                { id: 'mint', n: '민트', p: 100, css: 'linear-gradient(135deg,#d1fae5,#6ee7b7)' },
                { id: 'sky', n: '하늘', p: 100, css: 'linear-gradient(135deg,#e0f2fe,#7dd3fc)' },
                { id: 'rose', n: '핑크', p: 100, css: 'linear-gradient(135deg,#ffe4e6,#fda4af)' },
                { id: 'lemon', n: '레몬', p: 100, css: 'linear-gradient(135deg,#fef9c3,#fde047)' },
                { id: 'lavender', n: '라벤더', p: 150, css: 'linear-gradient(135deg,#ede9fe,#c4b5fd)' },
                { id: 'peach', n: '복숭아', p: 150, css: 'linear-gradient(135deg,#ffedd5,#fdba74)' },
                { id: 'ocean', n: '바다', p: 200, css: 'linear-gradient(135deg,#67e8f9,#3b82f6)' },
                { id: 'forest', n: '숲', p: 200, css: 'linear-gradient(135deg,#bbf7d0,#16a34a)' },
                { id: 'sunset', n: '노을', p: 200, css: 'linear-gradient(135deg,#fde68a,#fb7185)' },
                { id: 'cotton', n: '솜사탕', p: 250, css: 'linear-gradient(135deg,#fbcfe8,#a5f3fc)' },
                { id: 'night', n: '밤하늘', p: 300, css: 'linear-gradient(135deg,#312e81,#7c3aed)' },
                { id: 'fire', n: '불꽃', p: 300, css: 'linear-gradient(135deg,#fde047,#f97316,#dc2626)' },
                { id: 'aurora', n: '오로라', p: 400, css: 'linear-gradient(135deg,#34d399,#3b82f6,#a855f7)' },
                { id: 'rainbow', n: '무지개', p: 500, css: 'linear-gradient(135deg,#fca5a5,#fde68a,#86efac,#93c5fd,#c4b5fd)' },
                { id: 'neon', n: '네온', p: 500, css: 'linear-gradient(135deg,#f0abfc,#22d3ee)' },
                { id: 'gold', n: '황금', p: 600, css: 'linear-gradient(135deg,#fde68a,#f59e0b,#fde68a)' },
                { id: 'galaxy', n: '은하수', p: 700, css: 'radial-gradient(circle at 30% 30%,#a78bfa,#1e1b4b 70%)' },
                { id: 'glitter', n: '별가루 반짝', p: 1000, css: 'linear-gradient(135deg,#fbcfe8,#c4b5fd,#a5f3fc)', fx: 'glitter' },
                { id: 'holo', n: '홀로그램', p: 1200, css: 'linear-gradient(135deg,#ff9a9e,#fad0c4,#a1c4fd,#c2ffd8,#fbc2eb,#ff9a9e)', fx: 'holo' },
                { id: 'goldshine', n: '황금 광채', p: 1500, css: 'linear-gradient(135deg,#fde68a,#f59e0b,#fbbf24)', fx: 'goldshine' },
                { id: 'stardust', n: '별이 쏟아지는 밤', p: 1800, css: 'radial-gradient(circle at 30% 30%,#6d28d9,#0f172a 75%)', fx: 'stardust' },
                { id: 'flow', n: '무지개 물결', p: 2000, css: 'linear-gradient(135deg,#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f87171)', fx: 'flow' }
            ]
        };
        const EXTRA_SHOP_ITEMS = {
            tile: [
                {id:'tile:mint',n:'민트',p:0,cssClass:'skin-mint',rarity:'common'},
                {id:'tile:macaron',n:'마카롱',p:300,cssClass:'skin-macaron',rarity:'common'},
                {id:'tile:glass',n:'유리',p:450,cssClass:'skin-glass',rarity:'common'},
                {id:'tile:midnight',n:'미드나잇',p:550,cssClass:'skin-midnight',rarity:'common'},
                {id:'tile:candy',n:'솜사탕',p:800,cssClass:'skin-candy',rarity:'rare'},
                {id:'tile:neon',n:'네온',p:1100,cssClass:'skin-neon',rarity:'rare'},
                {id:'tile:gold',n:'황금',p:1700,cssClass:'skin-gold',rarity:'legendary'},
                {id:'tile:royal',n:'로열',p:2200,cssClass:'skin-royal',rarity:'legendary'},
                {id:'tile:prism',n:'프리즘 다이아',p:2800,cssClass:'skin-prism',rarity:'legendary'},
                {id:'tile:lava',n:'마그마 코어',p:1300,cssClass:'skin-lava',rarity:'rare'},
                {id:'tile:sakura',n:'벚꽃 만개',p:1100,cssClass:'skin-sakura',rarity:'rare'},
                {id:'tile:emerald',n:'에메랄드',p:2500,cssClass:'skin-emerald',rarity:'legendary'},
                {id:'tile:cyber',n:'사이버 펄스',p:1700,cssClass:'skin-cyber',rarity:'rare'},
                {id:'tile:cosmos',n:'우주 성운',p:3000,cssClass:'skin-cosmos',rarity:'legendary'}
            ],
            wing: [
                {id:'wing:none',n:'날개 없음',p:0,rarity:'common',icon:'🐾'},
                {id:'wing:angel',n:'천사 날개',p:550,rarity:'common',icon:'🪽'},
                {id:'wing:butterfly',n:'나비 날개',p:850,rarity:'rare',icon:'🦋'},
                {id:'wing:fairy',n:'요정 날개',p:1100,rarity:'rare',icon:'🧚'},
                {id:'wing:devil',n:'악마 날개',p:1450,rarity:'rare',icon:'🦇'},
                {id:'wing:fire',n:'불사조 날개',p:2100,rarity:'legendary',icon:'🔥'},
                {id:'wing:aurora',n:'오로라 날개',p:2800,rarity:'legendary',icon:'🌈'},
                {id:'wing:crystal',n:'크리스탈 날개',p:3400,rarity:'legendary',icon:'💎'}
            ],
            name: [
                {id:'name:plain',n:'기본 닉네임',p:0,rarity:'common',icon:'Aa'},
                {id:'name:rose',n:'로즈핑크',p:350,rarity:'common',icon:'🌷'},
                {id:'name:ocean',n:'바다빛',p:450,rarity:'common',icon:'🌊'},
                {id:'name:gold',n:'황금빛',p:850,rarity:'rare',icon:'👑'},
                {id:'name:neon',n:'네온 글로우',p:1250,rarity:'rare',icon:'⚡'},
                {id:'name:rainbow',n:'무지개 흐름',p:1750,rarity:'rare',icon:'🌈'},
                {id:'name:flame',n:'불꽃 닉네임',p:2350,rarity:'legendary',icon:'🔥'},
                {id:'name:galaxy',n:'은하수 닉네임',p:2950,rarity:'legendary',icon:'🌌'}
            ],
            victory: [
                {id:'fx:confetti',n:'색종이',p:0,icon:'🎊',rarity:'common'},
                {id:'fx:stars',n:'별가루',p:350,icon:'⭐',rarity:'common'},
                {id:'fx:hearts',n:'하트',p:500,icon:'💖',rarity:'common'},
                {id:'fx:flowers',n:'꽃비',p:700,icon:'🌸',rarity:'rare'},
                {id:'fx:lightning',n:'번개',p:950,icon:'⚡',rarity:'rare'},
                {id:'fx:diamonds',n:'다이아',p:1500,icon:'💎',rarity:'legendary'},
                {id:'fx:crowns',n:'왕관',p:1900,icon:'👑',rarity:'legendary'},
                {id:'fx:supernova',n:'슈퍼노바',p:2600,icon:'🌌',rarity:'legendary'},
                {id:'fx:dragon',n:'용의 포효',p:3000,icon:'🐉',rarity:'legendary'},
                {id:'fx:rainbow',n:'레인보우 피날레',p:1800,icon:'🌈',rarity:'rare'},
                {id:'fx:fireworks',n:'불꽃축제',p:1500,icon:'🎆',rarity:'rare'}
            ]
        };
        const SHOP_TABS = [['a', '🐾 동물'], ['hat', '🎩 모자'], ['face', '👓 얼굴'], ['neck', '🧣 목'], ['side', '🎈 손/옆'], ['bg', '🎨 배경'], ['wing','🪽 날개'], ['name','✨ 닉네임'], ['tile','🟩 타일'], ['victory','🎉 승리']];
        const catalog = cat => cat === 'a' ? AVATAR_BASES : (EXTRA_SHOP_ITEMS[cat] || SHOP_ITEMS[cat] || []);
        let shopTab = 'a';

        const defaultProfile = () => ({
            coins: 0,
            owned: AVATAR_BASES.filter(b => b.p === 0).map(b => b.id),
            eq: { a: '🐶', hat: '', face: '', neck: '', side: '', bg: '', tile:'tile:mint', victory:'fx:confetti', wing:'wing:none', name:'name:plain' },
            ts: 0
        });
        // 얼굴을 통째로 덮어서 제거한 아이템 → 이미 샀다면 코인으로 환불
        const REMOVED_ITEMS = { '😷': 150, '🎭': 300 };
        function parseProfile(p) {
            const d = defaultProfile();
            if (!p || typeof p !== 'object') return d;
            let refund = 0;
            const ownedRaw = Array.from(new Set(d.owned.concat(Array.isArray(p.owned) ? p.owned : [])));
            const owned = ownedRaw.filter(id => { if (REMOVED_ITEMS[id]) { refund += REMOVED_ITEMS[id]; return false; } return true; });
            const eq = Object.assign(d.eq, p.eq || {});
            if (REMOVED_ITEMS[eq.face]) eq.face = '';
            ['tile','victory','wing','name'].forEach(cat => { if (!catalog(cat).some(it => it.id === eq[cat] && (it.p === 0 || owned.includes(it.id)))) eq[cat] = defaultProfile().eq[cat]; });
            return {
                coins: Math.max(0, parseInt(p.coins, 10) || 0) + refund,
                owned, eq,
                ts: parseInt(p.ts, 10) || 0
            };
        }

        // 프로필(코인·보유 아이템·착용)은 '닉네임(아이디)' 기준으로 서버(profiles/)와 이 기기에 같이 저장돼요
        let profileNick = '';
        const nickKey = n => encodeURIComponent(String(n || '').trim().toLowerCase()).replace(/\./g, '%2E');
        const localKeyFor = n => 'wordle_profile::' + (n ? nickKey(n) : '_guest');
        function loadLocalProfile(n) {
            try { const raw = localStorage.getItem(localKeyFor(n)); if (raw) return parseProfile(JSON.parse(raw)); } catch (e) {}
            return null;
        }
        let profile = loadLocalProfile('') || (() => {
            try { const raw = localStorage.getItem('wordle_profile'); if (raw) return parseProfile(JSON.parse(raw)); } catch (e) {}
            return defaultProfile();
        })();

        let profileSaveTimer = null;
        function saveProfile() {
            profile.ts = Date.now();
            try { localStorage.setItem(localKeyFor(profileNick), JSON.stringify(profile)); } catch (e) {}
            if (!db || !profileNick) return;
            clearTimeout(profileSaveTimer);
            profileSaveTimer = setTimeout(pushProfileRemote, 600);
        }
        function pushProfileRemote() {
            if (!db || !profileNick) return;
            try {
                const p = db.ref('profiles/' + nickKey(profileNick)).set({ nick: profileNick, coins: profile.coins, owned: profile.owned, eq: profile.eq, ts: profile.ts });
                if (p && p.catch) p.catch(() => {});
            } catch (e) {}
        }
        function fetchRemoteProfile(n) {
            return new Promise(resolve => {
                if (!db) { resolve(null); return; }
                let done = false;
                const finish = v => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
                const t = setTimeout(() => finish(null), 2500);
                try {
                    db.ref('profiles/' + nickKey(n)).once('value').then(snap => finish(snap.val() ? parseProfile(snap.val()) : null)).catch(() => finish(null));
                } catch (e) { finish(null); }
            });
        }
        // 닉네임에 연결된 프로필로 전환: 서버/기기 중 가장 최근 저장본을 사용
        function switchProfile(nick) {
            nick = String(nick || '').trim();
            if (!nick || nick.toLowerCase() === profileNick.toLowerCase()) { if (nick) profileNick = nick; return Promise.resolve(); }
            try { localStorage.setItem('wordle_nick', nick); } catch (e) {}
            const guestBase = profileNick === '' ? profile : null;   // 닉네임 없이 모아둔 코인은 첫 닉네임에 이어붙여요
            const local = loadLocalProfile(nick);
            return fetchRemoteProfile(nick).then(remote => {
                let chosen = null;
                if (remote && local) chosen = (remote.ts >= local.ts) ? remote : local;
                else chosen = remote || local || guestBase || defaultProfile();
                profileNick = nick;
                profile = chosen;
                applyTileSkin();
                saveProfile();
                renderProfileBtn();
                if (!document.getElementById('shopModal').classList.contains('hidden')) renderShop();
                pushMyAvatar();
            });
        }

        // 외부(DB)에서 온 아바타 데이터는 상점 목록에 있는 값만 통과시켜요 (XSS/이상값 방지)
        function sanitizeAv(av) {
            const out = { a: '🐶', hat: '', face: '', neck: '', side: '', bg: '', wing:'wing:none' };
            if (!av || typeof av !== 'object') return out;
            SHOP_TABS.filter(([cat]) => !['tile','victory','name'].includes(cat)).forEach(([cat]) => {
                const v = av[cat];
                if (typeof v === 'string' && catalog(cat).some(it => it.id === v)) out[cat] = v;
            });
            return out;
        }
        function myAvatar() { return sanitizeAv(profile.eq); }

        // ── 캐릭터 조합 배치표 (크기·위치는 캐릭터 크기 대비 비율) ──────────────────
        // 얼굴이 정면인 동물에게만 안경/볼 장식이 보여요 (물고기·곤충·펭귄 등은 얼굴 위치가 달라서 제외)
        const FACE_BASES = new Set(['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐴','🦄','🐺','🐗','🐲','👻','🎃','👽','🤖']);
        const HAT_DEFAULT = { fs: 0.46, t: -0.30 };
        const HAT_LAYOUT = {
            '🎩': { fs: 0.50, t: -0.32 }, '👑': { fs: 0.46, t: -0.30 }, '🧢': { fs: 0.46, t: -0.28 }, '👒': { fs: 0.54, t: -0.28 },
            '🎓': { fs: 0.50, t: -0.30 }, '⛑️': { fs: 0.46, t: -0.26 }, '🎧': { fs: 0.58, t: -0.22 },
            '🌻': { fs: 0.40, t: -0.30 }, '🍉': { fs: 0.40, t: -0.28 }, '🍄': { fs: 0.40, t: -0.28 }, '🔥': { fs: 0.40, t: -0.30 },
            '🌈': { fs: 0.44, t: -0.28 }, '⭐': { fs: 0.34, t: -0.28 }, '🌸': { fs: 0.34, t: -0.24 }, '🍀': { fs: 0.34, t: -0.24 }, '🎀': { fs: 0.38, t: -0.24 }
        };
        // face:true = 얼굴 위에 올라가는 장식 (정면 얼굴 동물에게만 표시) / cx = 가로 중심 위치
        const FACE_LAYOUT = {
            '👓': { fs: 0.46, cx: 0.50, t: 0.20, face: true }, '🕶️': { fs: 0.46, cx: 0.50, t: 0.20, face: true }, '🥽': { fs: 0.46, cx: 0.50, t: 0.20, face: true },
            '💋': { fs: 0.20, cx: 0.24, t: 0.52, face: true }, '💖': { fs: 0.20, cx: 0.72, t: 0.54, face: true }, '🌹': { fs: 0.28, cx: 0.17, t: 0.14, face: true },
            '✨': { fs: 0.28, cx: 0.88, t: -0.02 }, '💫': { fs: 0.28, cx: 0.12, t: -0.02 }
        };
        function faceItemVisible(av) {
            const L = av && av.face ? FACE_LAYOUT[av.face] : null;
            return !!L && (!L.face || FACE_BASES.has(av.a));
        }

        // Each wing is rendered as a dedicated SVG file, avoiding duplicated gradient IDs and oversized DOM.
        const WING_ASSET_IDS = new Set(['angel','butterfly','fairy','devil','fire','aurora','crystal']);
        function wingSvgHtml(wingId) {
            const kind = String(wingId || '').replace('wing:', '');
            if (!WING_ASSET_IDS.has(kind)) return '';
            return `<span class="av-wing-art wing-type-${kind}" aria-hidden="true"><img src="assets/wings/${kind}.svg" alt="" draggable="false" loading="eager"></span>`;
        }

        function avatarHtml(av, size, bounce) {
            av = av || sanitizeAv(null);
            size = size || 40;
            const bgItem = SHOP_ITEMS.bg.find(b => b.id === av.bg);
            const bg = bgItem ? bgItem.css : '#f1f5f9';
            const r = n => Math.round(size * n);
            const hatL = av.hat ? (HAT_LAYOUT[av.hat] || HAT_DEFAULT) : null;
            const faceL = faceItemVisible(av) ? FACE_LAYOUT[av.face] : null;
            // 바깥으로 튀어나오는 만큼 여백을 줘서 다른 요소와 겹치지 않게
            const margin = `margin:${hatL ? r(-hatL.t) : 0}px ${av.side || (av.wing && av.wing !== 'wing:none') ? r(0.35) : 0}px ${av.neck ? r(0.16) : 0}px ${av.wing && av.wing !== 'wing:none' ? r(0.35) : 0}px;`;
            const fx = bgItem && bgItem.fx ? ` fx fx-${bgItem.fx}` : '';
            return `<span class="av${bounce ? ' av-bounce' : ''}${fx}" style="width:${size}px;height:${size}px;background:${bg};font-size:${r(0.62)}px;${margin}">` +
                (av.wing && av.wing !== 'wing:none' ? wingSvgHtml(av.wing) : '') +
                `<span class="av-base">${av.a}</span>` +
                (hatL ? `<span class="av-hat" style="font-size:${r(hatL.fs)}px;top:${r(hatL.t)}px">${av.hat}</span>` : '') +
                (faceL ? `<span class="av-face" style="font-size:${r(faceL.fs)}px;left:${faceL.cx * 100}%;top:${r(faceL.t)}px">${av.face}</span>` : '') +
                (av.neck ? `<span class="av-neck" style="font-size:${r(0.38)}px;top:${r(0.78)}px">${av.neck}</span>` : '') +
                (av.side ? `<span class="av-side" style="font-size:${r(0.52)}px;left:${r(0.80)}px;top:${r(0.50)}px">${av.side}</span>` : '') +
                `</span>`;
        }

        function renderProfileBtn() {
            document.getElementById('profileBtn').innerHTML = `<span class="mt-0.5">${avatarHtml(myAvatar(), 34)}</span><span>🪙 ${profile.coins}</span>`;
        }

        function awardCoinsOnce(key, amount) {
            let stored = null;
            try { stored = localStorage.getItem('wordle_last_coin'); } catch (e) {}
            if (lastCoinKey === key || stored === key) return false;
            lastCoinKey = key;
            try { localStorage.setItem('wordle_last_coin', key); } catch (e) {}
            profile.coins += amount;
            saveProfile();
            renderProfileBtn();
            return true;
        }

        function pushMyAvatar() {
            if (!db || !currentRoomCode || !lastRoomData || !lastRoomData.players || !lastRoomData.players[myUid]) return;
            db.ref(`rooms/${currentRoomCode}/players/${myUid}`).update({avatar:myAvatar(),nameStyle:safeNameStyle(profile.eq.name)});
        }

        function openShop() { renderShop(); document.getElementById('shopModal').classList.remove('hidden'); }
        function closeShop() { document.getElementById('shopModal').classList.add('hidden'); }
        function clearAccessories() {
            profile.eq.hat = ''; profile.eq.face = ''; profile.eq.neck = ''; profile.eq.side = ''; profile.eq.wing = 'wing:none';
            saveProfile(); renderShop(); renderProfileBtn(); pushMyAvatar();
            showToast('장식을 모두 벗었어요. (배경은 그대로예요)');
        }

        function setShopTab(cat) { shopTab = cat; renderShop(); }

        function renderShop() {
            document.getElementById('shopPreview').innerHTML = `<div class="flex flex-col items-center gap-2">${avatarHtml(myAvatar(), 96, true)}${styledNameHtml(profileNick || '나의 닉네임', profile.eq.name)}</div>`;
            document.getElementById('shopOwner').textContent = profileNick
                ? `🔗 '${profileNick}' 아이디에 저장돼요 (방을 새로 만들어도 유지!)`
                : '닉네임으로 방에 입장하면 그 아이디에 코인이 저장돼요.';
            document.getElementById('shopCoins').textContent = `🪙 ${profile.coins}`;
            document.getElementById('shopTabs').innerHTML = SHOP_TABS.map(([cat, label]) =>
                `<button onclick="setShopTab('${cat}')" class="py-2 rounded-lg text-sm font-black text-center transition ${shopTab === cat ? 'bg-emerald-600 text-white shadow-md ring-2 ring-emerald-300' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}">${label}</button>`
            ).join('');
            const curTab = SHOP_TABS.find(t => t[0] === shopTab) || SHOP_TABS[0];
            const curItems = catalog(shopTab);
            const ownedCnt = curItems.filter(it => it.p === 0 || profile.owned.includes(it.id)).length;
            document.getElementById('shopCatInfo').textContent = `${curTab[1]} · 총 ${curItems.length}종 (보유 ${ownedCnt})`;
            const noteEl = document.getElementById('shopFaceNote');
            const faceHidden = shopTab === 'face' && !FACE_BASES.has(profile.eq.a);
            noteEl.classList.toggle('hidden', !faceHidden);
            if (faceHidden) noteEl.textContent = '⚠️ 지금 캐릭터는 얼굴이 정면이 아니라 안경·볼 장식이 보이지 않아요. (✨ 💫 는 가능!) 🐶🐱🐰🐻🐼🦊 같은 동물에게 어울려요.';
            document.getElementById('shopGrid').innerHTML = curItems.map(it => {
                const owned = it.p === 0 || profile.owned.includes(it.id);
                const equipped = profile.eq[shopTab] === it.id;
                const preview = shopTab === 'bg'
                    ? `<div class="mx-auto w-10 h-10 rounded-full border border-slate-200 relative${it.fx ? ' fx fx-' + it.fx : ''}" style="background:${it.css}"></div>`
                    : shopTab === 'tile'
                    ? `<div class="mx-auto w-10 h-10 rounded-lg border-2 border-slate-300 ${it.cssClass}" style="background:${tileSampleBackground(it.id)}"></div>`
                    : shopTab === 'wing'
                    ? `<div class="flex items-center justify-center h-16 pt-1">${avatarHtml(sanitizeAv({...profile.eq,wing:it.id}), 38)}</div>`
                    : shopTab === 'name'
                    ? `<div class="h-10 flex items-center justify-center">${styledNameHtml('닉네임',it.id)}</div>`
                    : shopTab === 'victory'
                    ? `<div class="h-14 flex flex-col items-center justify-center gap-1"><span class="text-3xl">${it.icon}</span><button type="button" onclick="event.stopPropagation();previewVictoryEffect('${it.id}')" class="text-[10px] font-black text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full hover:bg-indigo-100">▶ 미리보기</button></div>`
                    : `<div class="text-3xl leading-none h-10 flex items-center justify-center">${it.id}</div>`;
                const label = equipped ? '착용중 ✓' : (owned ? '착용하기' : `🪙 ${it.p}`);
                const labelCls = equipped ? 'text-emerald-700' : (owned ? 'text-slate-600' : (profile.coins >= it.p ? 'text-amber-600' : 'text-slate-400'));
                const dim = faceHidden && FACE_LAYOUT[it.id] && FACE_LAYOUT[it.id].face;
                return `<div class="shop-item ${equipped ? 'equipped' : ''}${dim ? ' opacity-50' : ''}" onclick="shopItemClick('${shopTab}','${it.id}')">
                    ${preview}<p class="text-xs font-black text-slate-800 mt-1 leading-tight">${it.n}</p><p class="text-xs font-bold ${labelCls}">${label}</p></div>`;
            }).join('');
        }

        function shopItemClick(cat, id) {
            const it = catalog(cat).find(x => x.id === id);
            if (!it) return;
            const owned = it.p === 0 || profile.owned.includes(id);
            if (!owned) {
                if (profile.coins < it.p) { showToast(`코인이 부족해요! (필요 ${it.p} / 보유 ${profile.coins})`); return; }
                if (!confirm(`'${it.n}' 을(를) 🪙${it.p} 코인에 구매할까요?`)) return;
                profile.coins -= it.p;
                profile.owned.push(id);
                profile.eq[cat] = id;
            } else if (profile.eq[cat] === id && cat !== 'a') {
                profile.eq[cat] = '';
            } else {
                profile.eq[cat] = id;
            }
            saveProfile();
            renderShop();
            renderProfileBtn();
            pushMyAvatar();
            applyTileSkin();
        }

        // ── 별도 상점 확장: 타일 / 승리 이펙트 / 상자 ──
        function tileSampleBackground(id) {
            return ({'tile:mint':'#dcfce7','tile:macaron':'#fff0f7','tile:glass':'linear-gradient(140deg,#eefbff,#e0e7ff)',
                'tile:midnight':'#0f172a','tile:candy':'linear-gradient(130deg,#fdf2f8,#ddd6fe,#cffafe)',
                'tile:neon':'#142034','tile:gold':'linear-gradient(145deg,#fffbeb,#fcd34d)',
                'tile:royal':'linear-gradient(145deg,#312e81,#6d28d9)',
                'tile:prism':'linear-gradient(125deg,#f0abfc,#67e8f9,#fef08a)',
                'tile:lava':'linear-gradient(125deg,#450a0a,#ef4444,#f97316)',
                'tile:sakura':'linear-gradient(125deg,#fff1f2,#f9a8d4,#fce7f3)',
                'tile:emerald':'linear-gradient(125deg,#022c22,#059669,#6ee7b7)',
                'tile:cyber':'linear-gradient(125deg,#020617,#0e7490,#a21caf)',
                'tile:cosmos':'radial-gradient(circle at 30% 20%,#7c3aed,#020617 78%)'})[id] || '#fff';
        }
        function applyTileSkin() {
            const board = document.getElementById('board');
            if (!board) return;
            const item = catalog('tile').find(it => it.id === profile.eq.tile);
            for (const it of catalog('tile')) board.classList.remove(it.cssClass);
            if (item) board.classList.add(item.cssClass);
        }
        let victoryCleanup = null;
        function playVictoryEffect() {
            if (!window.TodaywordVictory) return;
            window.TodaywordVictory.play(profile.eq.victory || 'fx:confetti');
        }
        function previewVictoryEffect(id) {
            if (!catalog('victory').some(it => it.id === id)) return;
            if (window.TodaywordVictory) window.TodaywordVictory.play(id);
        }
        const LOOT_PRICE = 400;
        const LOOT_WEIGHTS = [{rarity:'common',weight:60},{rarity:'rare',weight:30},{rarity:'legendary',weight:10}];
        let lootBusy = false;
        function openLootBox() {
            closeShop();
            document.getElementById('lootModal').classList.remove('hidden');
            document.getElementById('lootResult').textContent = '미보유 아이템을 한 개 획득합니다. (중복 없음)';
            refreshLootUI();
        }
        function closeLootBox() { if (!lootBusy) document.getElementById('lootModal').classList.add('hidden'); }
        function lootAvailable() {
            return ['tile','victory','wing','name'].flatMap(cat => catalog(cat).filter(it => it.p > 0 && !profile.owned.includes(it.id)).map(it => ({...it,cat})));
        }
        function refreshLootUI() {
            document.getElementById('lootCoins').textContent = `보유 🪙 ${profile.coins} · 가격 🪙 ${LOOT_PRICE}`;
            const btn = document.getElementById('lootOpenBtn');
            const count = lootAvailable().length;
            btn.disabled = lootBusy || profile.coins < LOOT_PRICE || count === 0;
            btn.textContent = count === 0 ? '🎉 모든 상자 아이템 수집 완료!' : (profile.coins < LOOT_PRICE ? '코인이 부족해요' : '🪙 400코인으로 열기');
            btn.classList.toggle('opacity-50', btn.disabled);
        }
        function secureRandomFloat() {
            if (window.crypto && window.crypto.getRandomValues) {
                const a = new Uint32Array(1);
                window.crypto.getRandomValues(a);
                return a[0] / 4294967296;
            }
            return Math.random();
        }
        function pickLootItem(available) {
            // 품절 등급의 가중치는 제거하고 남은 등급의 원래 비율로 재정규화.
            const active = LOOT_WEIGHTS.filter(w => available.some(it => it.rarity === w.rarity));
            const total = active.reduce((sum,w) => sum+w.weight, 0);
            let hit = secureRandomFloat()*total;
            let rarity = active[active.length-1].rarity;
            for (const w of active) { hit -= w.weight; if (hit < 0) { rarity = w.rarity; break; } }
            const pool = available.filter(it => it.rarity === rarity);
            return pool[Math.floor(secureRandomFloat()*pool.length)];
        }
        function buyLootBox() {
            if (lootBusy || profile.coins < LOOT_PRICE) { refreshLootUI(); return; }
            const available = lootAvailable();
            if (!available.length) { refreshLootUI(); return; }
            lootBusy = true;
            try {
                const item = pickLootItem(available);
                profile.coins -= LOOT_PRICE;
                profile.owned.push(item.id);
                saveProfile(); renderProfileBtn();
                const grade = {common:'일반',rare:'희귀',legendary:'전설'}[item.rarity];
                const result = document.getElementById('lootResult');
                result.classList.remove('loot-result'); void result.offsetWidth; result.classList.add('loot-result');
                result.textContent = `${({tile:'🟩 타일',victory:'🎉 승리',wing:'🪽 날개',name:'✨ 닉네임'}[item.cat])} · ${grade} · ${item.n} 획득! 상점에서 장착할 수 있어요.`;
            } finally { lootBusy = false; refreshLootUI(); }
        }

        // ═══════════════════════════════════════════════════════════════
        //  🏆 토탈 점수제 / 실시간 순위
        //   - 정답 기본점: 1번째 100 · 2번째 80 · 3번째 60 · 4번째 40 · 5번째 20
        //   - 스피드 보너스: 가장 빨리 맞힌 순서대로 +30 / +20 / +10
        //   - 타임어택 보너스: 남은 시간 비율 × 20점
        //   - 힌트 페널티: 공개된 힌트 1개당 -10점 (정답자 최소 10점)
        //   - 출제자: 문제를 못 푼 참가자 1명당 +15점 (최대 +60)
        // ═══════════════════════════════════════════════════════════════
        const toArr = v => Array.isArray(v) ? v : Object.values(v || {});

        // 프로필에서 구매 가능한 닉네임 스타일만 허용 (Firebase 값 그대로 CSS에 삽입하지 않음)
        function safeNameStyle(id) {
            return catalog('name').some(item => item.id === id) ? id : 'name:plain';
        }
        function styledNameHtml(nick, styleId, uid='') {
            const cls = 'nick-' + safeNameStyle(styleId).split(':')[1];
            return `<span class="pname ${cls}"${uid ? ` data-nameuid="${escapeHtml(uid)}"` : ''}>${escapeHtml(nick)}</span>`;
        }
        function nameHtml(uid, nick, styleOverride) {
            const p = lastRoomData && lastRoomData.players && lastRoomData.players[uid];
            const style = (p && p.nameStyle) || styleOverride || (uid === myUid ? profile.eq.name : 'name:plain');
            return `${crown(uid)}${styledNameHtml(nick, style, uid)}`;
        }

        function calcRoundScores(data) {
            const out = {};
            if (!data || !data.secretWord || !data.players) return out;
            const secret = data.secretWord;
            const hintCnt = Object.keys((data.hintState || {}).revealed || {}).length;
            const limitMs = (data.timeLimit || 0) * 1000;
            const start = data.startedAt || 0;
            const parts = Object.entries(data.players).filter(([u, p]) => u !== data.masterUid && !p.spectator);

            const solvers = parts
                .map(([u, p]) => ({ u, p, g: toArr(p.guesses) }))
                .filter(x => x.g.includes(secret))
                .sort((a, b) => (a.p.solvedTimestamp || 9e15) - (b.p.solvedTimestamp || 9e15));

            solvers.forEach((x, i) => {
                const k = x.g.indexOf(secret) + 1;
                const base = Math.max(10, (maxGuesses + 1 - k) * 20);
                const speed = [30, 20, 10][i] || 0;
                let time = 0;
                if (limitMs > 0 && start && x.p.solvedTimestamp) {
                    time = Math.round(20 * Math.max(0, Math.min(1, (start + limitMs - x.p.solvedTimestamp) / limitMs)));
                }
                const hint = Math.min(hintCnt * 10, Math.max(0, base - 10));
                out[x.u] = { total: Math.max(10, base + speed + time - hint), base, speed, time, hint, role: 'solver' };
            });

            const failed = parts.filter(([u, p]) => p.completed && !toArr(p.guesses).includes(secret)).length;
            const bonus = Math.min(failed * 15, 60);
            if (bonus > 0 && data.masterUid && data.players[data.masterUid]) {
                out[data.masterUid] = { total: bonus, master: bonus, role: 'master' };
            }
            return out;
        }

        function getStandings(data) {
            const rs = calcRoundScores(data);
            return Object.entries(data.players || {})
                .filter(([u, p]) => !p.spectator || p.waiting || (p.score || 0) > 0)
                .map(([u, p]) => {
                    const live = (rs[u] && rs[u].total) || 0;
                    return { uid: u, nickname: p.nickname || '?', avatar: p.avatar, score: p.score || 0, live, total: (p.score || 0) + live, isMaster: u === data.masterUid };
                })
                .sort((a, b) => b.total - a.total || b.score - a.score || a.nickname.localeCompare(b.nickname));
        }

        function withRanks(list) {
            let prevTotal = null, prevRank = 0;
            return list.map((x, i) => {
                const rank = (prevTotal !== null && x.total === prevTotal) ? prevRank : i + 1;
                prevTotal = x.total; prevRank = rank;
                return Object.assign({}, x, { rank });
            });
        }
        const rankMedal = r => r === 1 ? '🥇' : (r === 2 ? '🥈' : (r === 3 ? '🥉' : r));

        function toggleRankExpand() {
            rankExpanded = !rankExpanded;
            if (lastRoomData) updateScoreboard(lastRoomData);
        }

        function updateScoreboard(data) {
            const panel = document.getElementById('rankPanel');
            if (!data || !data.players) { panel.classList.add('hidden'); return; }
            const st = withRanks(getStandings(data));
            if (st.length === 0) { panel.classList.add('hidden'); return; }
            panel.classList.remove('hidden');

            // 1등(공동 포함) 갱신 + 순위 변동 알림
            const top = st[0].total;
            const newLeaders = new Set(top > 0 ? st.filter(x => x.total === top).map(x => x.uid) : []);
            const changed = [...newLeaders].sort().join(',') !== [...leaderUids].sort().join(',');
            const me = st.find(x => x.uid === myUid);
            let toastDone = false;
            if (leaderInit && changed && newLeaders.size === 1) {
                const u = [...newLeaders][0];
                const who = st.find(x => x.uid === u);
                showToast(u === myUid ? '🥇 내가 1등이에요! 채팅창에서 반짝반짝 빛나요 ✨' : `🥇 ${who.nickname}님이 1등으로 올라섰어요!`, 2800);
                toastDone = true;
            }
            if (leaderInit && !toastDone && me && myPrevRank !== null && me.rank < myPrevRank && top > 0) {
                showToast(`🔥 ${me.rank}위로 상승했어요!`);
            }
            myPrevRank = me ? me.rank : null;
            leaderUids = newLeaders;
            leaderInit = true;

            const view = rankExpanded ? st : st.filter((x, i) => i < 3 || x.uid === myUid);
            document.getElementById('rankList').innerHTML = view.map(x => {
                const isLead = leaderUids.has(x.uid);
                return `
                <div class="flex items-center gap-2 px-2 py-1.5 rounded-lg border text-xs ${isLead ? 'bg-amber-50 border-amber-300 ring-2 ring-amber-200' : (x.uid === myUid ? 'bg-emerald-100 border-emerald-300' : 'bg-white border-emerald-100')}">
                    <span class="w-6 text-center font-black text-sm">${x.total > 0 ? rankMedal(x.rank) : x.rank}</span>
                    <span>${avatarHtml(sanitizeAv(x.avatar), isLead ? 46 : 34, isLead)}</span>
                    <span class="flex-1 truncate font-bold text-slate-700">${nameHtml(x.uid, x.nickname)}${x.isMaster ? ' <span class="text-[10px] text-emerald-600 font-semibold">출제</span>' : ''}</span>
                    ${x.live > 0 ? `<span class="text-[10px] text-emerald-600 font-bold">+${x.live}</span>` : ''}
                    <span class="font-black tabular-nums text-slate-800 text-sm">${x.total}</span>
                </div>`;
            }).join('');

            const tgl = document.getElementById('rankToggleBtn');
            tgl.classList.toggle('hidden', st.length <= 3);
            tgl.textContent = rankExpanded ? '접기 ▲' : `전체 보기 (${st.length}명) ▼`;
            applyLeaderStyles();
        }

        function applyLeaderStyles() {
            document.querySelectorAll('[data-nameuid]').forEach(el => el.classList.toggle('leader-name', leaderUids.has(el.dataset.nameuid)));
            document.querySelectorAll('.chat-msg').forEach(el => el.classList.toggle('leader-msg', leaderUids.has(el.dataset.uid)));
        }

        // ═══════════════════════════════════════════════════════════════
        //  ⏱ 타임어택
        // ═══════════════════════════════════════════════════════════════
        function startTimerLoop() {
            stopTimerLoop();
            timerInterval = setInterval(updateTimerUI, 1000);
            updateTimerUI();
        }
        function stopTimerLoop() {
            if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
        }
        function fmtTime(ms) {
            const s = Math.max(0, Math.ceil(ms / 1000));
            return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        }

        function updateTimerUI() {
            const row = document.getElementById('timerRow');
            const d = lastRoomData;
            if (!currentRoomCode || !d || !d.secretWord) { row.classList.add('hidden'); return; }
            row.classList.remove('hidden');
            const txt = document.getElementById('timerText');
            const bar = document.getElementById('timerBar');

            if (!d.timeLimit) {
                txt.textContent = '⏱ 제한 시간 없음 (무제한)';
                txt.className = 'text-sm font-black text-slate-600';
                bar.style.width = '100%';
                bar.className = 'h-full bg-slate-300';
                return;
            }
            const total = d.timeLimit * 1000;
            const remain = (d.startedAt || serverNow()) + total - serverNow();
            const urgent = remain <= 30000;
            bar.style.width = Math.max(0, Math.min(100, remain / total * 100)) + '%';
            bar.className = 'h-full ' + (urgent ? 'bg-rose-500' : 'bg-emerald-500');
            if (remain <= 0) {
                txt.textContent = '⏰ 시간 종료!';
                txt.className = 'text-sm font-black text-rose-600';
                handleTimeUp(d);
            } else {
                txt.textContent = `⏱ 남은 시간 ${fmtTime(remain)}`;
                txt.className = 'text-sm font-black ' + (urgent ? 'text-rose-600 animate-pulse' : 'text-emerald-700');
            }
        }

        function handleTimeUp(d) {
            if (!isMaster && !isSpectator && !isGameOver) {
                timedOut = true;
                isGameOver = true;
                currentGuess = '';
                renderBoard();
                syncMyProgress();
                updateHintButton();
                refreshRoomView();
                showToast('⏰ 시간 종료! 정답을 확인해 보세요.', 3000);
            }
            const key = `${currentRoomCode}:${d.round || 1}:${d.secretWord}:${d.startedAt}`;
            if ((isMaster || isHost) && timeUpKey !== key) {
                timeUpKey = key;
                const word = d.secretWord;
                // 연결이 끊긴 참가자까지 포함해서 라운드가 끝나도록 출제자/방장이 강제 완료 처리
                setTimeout(() => forceCompleteAll(word), 2500);
            }
        }

        function forceCompleteAll(word) {
            if (!db || !currentRoomCode) return;
            db.ref(`rooms/${currentRoomCode}`).once('value', snap => {
                const d = snap.val();
                if (!d || d.secretWord !== word || !d.players) return;
                const ups = {};
                Object.entries(d.players).forEach(([u, p]) => {
                    if (u !== d.masterUid && !p.spectator && !p.completed) {
                        ups[`players/${u}/completed`] = true;
                        ups[`players/${u}/timedOut`] = true;
                    }
                });
                if (Object.keys(ups).length) db.ref(`rooms/${currentRoomCode}`).update(ups);
            });
        }


        // ═══════════════════════════════════════════════════════════════
        //  👀 관전 ↔ 🎮 문제 풀기 전환 / 강제 관전 전환(출제자·방장)
        // ═══════════════════════════════════════════════════════════════
        function updateSpectateBtn() {
            const btn = document.getElementById('spectateBtn');
            if (!btn) return;
            const me = lastRoomData && lastRoomData.players && lastRoomData.players[myUid];
            // 출제자는 전환 불가 / 풀이를 이미 마친 참가자는 어차피 관전 화면
            const show = !!currentRoomCode && !isMaster && !!me && !(isGameOver && !isSpectator);
            btn.classList.toggle('hidden', !show);
            if (!show) return;
            const roundActive = !!(lastRoomData && lastRoomData.secretWord);
            if (isSpectator) {
                btn.textContent = !roundActive ? '🎮 문제 풀기 전환' : (me.waiting ? '🎮 참여 예약 취소' : '🎮 다음 판부터 참여');
                btn.className = 'px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg transition';
            } else {
                btn.textContent = '👀 관전 전환';
                btn.className = 'px-3 py-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold rounded-lg transition';
            }
        }

        function toggleSpectate() {
            if (!db || !currentRoomCode || isMaster || !lastRoomData) return;
            const me = (lastRoomData.players || {})[myUid];
            if (!me) return;
            const base = `rooms/${currentRoomCode}/players/${myUid}`;
            const roundActive = !!lastRoomData.secretWord;
            if (!isSpectator) {
                if (isGameOver) { showToast('이미 풀이를 마쳤어요!'); return; }
                if (roundActive && !confirm('이번 라운드를 포기하고 관전 모드로 전환할까요?\n(이번 라운드 점수는 없어요. 언제든 다시 문제 풀기로 돌아올 수 있어요.)')) return;
                db.ref(base).update({ spectator: true, completed: true, waiting: null, timedOut: null });
                isSpectator = true;
                refreshRoomView();
                updateHintButton();
                showToast('👀 관전 모드로 전환했어요.');
            } else if (!roundActive) {
                // 출제 전에는 바로 문제 풀기로 전환
                db.ref(base).update({ spectator: false, completed: false, waiting: null, guesses: [], solvedTimestamp: 0, timedOut: null });
                isSpectator = false;
                resetGameData({ skipSync: true });
                refreshRoomView();
                updateHintButton();
                showToast('🎮 문제 풀기 모드로 전환했어요! 출제를 기다려 주세요.');
            } else {
                // 진행 중인 라운드는 다음 라운드부터 참여 (정답 보고 들어오는 반칙 방지)
                const next = !me.waiting;
                db.ref(base).update({ waiting: next ? true : null });
                showToast(next ? '⏳ 다음 라운드부터 문제를 풀 수 있게 예약했어요!' : '예약을 취소했어요. 계속 관전해요.');
            }
        }

        function forceBtnFor(uid, p, masterUid) {
            if (!(isMaster || isHost) || p.spectator || p.completed || uid === masterUid || protectedSolver(p)) return '';
            return `<button data-uid="${escapeHtml(uid)}" onclick="forceSpectate(this.dataset.uid)" class="px-2 py-0.5 bg-sky-600 hover:bg-sky-700 text-white text-[10px] font-bold rounded-md">관전 전환</button>`;
        }

        function renderForceBar(players, masterUid) {
            const el = document.getElementById('forceBar');
            if (!el) return;
            const pending = Object.entries(players || {}).filter(([u, p]) => u !== masterUid && !p.spectator && !p.completed && !protectedSolver(p));
            if (!(isMaster || isHost) || !(lastRoomData && lastRoomData.secretWord) || pending.length === 0) {
                el.classList.add('hidden'); el.innerHTML = ''; return;
            }
            el.classList.remove('hidden');
            el.innerHTML = `<button onclick="forceSpectateAll()" class="w-full py-2 bg-sky-50 hover:bg-sky-100 border border-sky-200 text-sky-700 text-xs font-bold rounded-lg transition">🚦 아직 풀고 있는 ${pending.length}명을 관전자로 전환해서 진행하기</button>`;
        }

        function forceSpectate(uid) {
            if (!(isMaster || isHost) || !db || !currentRoomCode || !lastRoomData) return;
            const p = (lastRoomData.players || {})[uid];
            if (!p || uid === lastRoomData.masterUid || p.spectator || p.completed) return;
            if (protectedSolver(p)) { showToast("⛔ 접속 중인 풀이 참가자는 관전 전환할 수 없어요."); return; }
            if (!confirm(`'${p.nickname}'님을 관전자로 전환할까요?\n(이번 라운드 풀이는 종료돼요. 본인이 원하면 다시 문제 풀기로 돌아올 수 있어요.)`)) return;
            db.ref(`rooms/${currentRoomCode}/players/${uid}`).update({ spectator: true, completed: true, waiting: null, timedOut: null });
            showToast(`👀 ${p.nickname}님을 관전자로 전환했어요.`);
        }

        function forceSpectateAll() {
            if (!(isMaster || isHost) || !db || !currentRoomCode || !lastRoomData) return;
            const d = lastRoomData;
            const pending = Object.entries(d.players || {}).filter(([u, p]) => u !== d.masterUid && !p.spectator && !p.completed && !protectedSolver(p));
            if (pending.length === 0) return;
            if (!confirm(`아직 풀이를 끝내지 않은 ${pending.length}명을 모두 관전자로 전환할까요?\n(이번 라운드가 바로 마무리돼요.)`)) return;
            const ups = {};
            pending.forEach(([u]) => {
                ups[`players/${u}/spectator`] = true;
                ups[`players/${u}/completed`] = true;
                ups[`players/${u}/waiting`] = null;
                ups[`players/${u}/timedOut`] = null;
            });
            db.ref(`rooms/${currentRoomCode}`).update(ups);
            showToast(`👀 ${pending.length}명을 관전자로 전환했어요.`);
        }

        // ═══════════════════════════════════════════════════════════════
        //  🎰 코인 도박장 (배팅액은 시작할 때 바로 차감 → 새로고침으로 취소 불가)
        // ═══════════════════════════════════════════════════════════════
        const CASINO_MIN_BET = 10;
        const CASINO_GAMES = [['coin', '🪙 동전'], ['slot', '🎰 슬롯'], ['roulette', '🎡 룰렛']];
        const SLOT_SYMBOLS = ['🍒', '🍋', '🔔', '⭐', '7️⃣'];
        const ROULETTE = [
            { m: 0, w: 43, t: '💥 꽝' }, { m: 0.5, w: 20, t: '😅 ×0.5' }, { m: 1.5, w: 20, t: '🙂 ×1.5' },
            { m: 2, w: 11, t: '😄 ×2' }, { m: 5, w: 5, t: '🤩 ×5' }, { m: 10, w: 1, t: '🎉 ×10 JACKPOT' }
        ];
        let casinoGame = 'coin', casinoBet = 50, casinoBusy = false, casinoLog = [];

        function casinoRand() {
            try { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] / 4294967296; } catch (e) { return Math.random(); }
        }
        function openCasino() {
            closeShop();
            casinoBet = Math.max(CASINO_MIN_BET, Math.min(casinoBet, Math.max(CASINO_MIN_BET, profile.coins)));
            renderCasino();
            document.getElementById('casinoResult').textContent = '';
            document.getElementById('casinoModal').classList.remove('hidden');
        }
        function closeCasino() {
            document.getElementById('casinoModal').classList.add('hidden');
            renderProfileBtn();
        }
        function setCasinoGame(g) { if (casinoBusy) return; casinoGame = g; renderCasino(); document.getElementById('casinoResult').textContent = ''; }
        function setCasinoBet(v) {
            if (casinoBusy) return;
            if (v === 'all') {
                if (profile.coins < CASINO_MIN_BET) { showToast('코인이 부족해요!'); return; }
                casinoBet = profile.coins;
            } else casinoBet = v;
            document.getElementById('casinoBetInput').value = casinoBet;
        }
        function casinoBetFromInput() { casinoBet = parseInt(document.getElementById('casinoBetInput').value, 10) || 0; }

        function renderCasino() {
            document.getElementById('casinoCoins').textContent = `🪙 ${profile.coins}`;
            document.getElementById('casinoTabs').innerHTML = CASINO_GAMES.map(([g, label]) =>
                `<button onclick="setCasinoGame('${g}')" class="py-2 rounded-lg text-xs font-black transition ${casinoGame === g ? 'bg-amber-400 text-slate-900' : 'bg-white/10 text-white hover:bg-white/20'}">${label}</button>`).join('');
            document.getElementById('casinoBetChips').innerHTML = [10, 50, 100, 500, 'all'].map(v =>
                `<button onclick="setCasinoBet(${v === 'all' ? "'all'" : v})" class="py-1.5 rounded-lg text-xs font-bold bg-white/10 hover:bg-white/20 transition">${v === 'all' ? '올인' : v}</button>`).join('');
            const inp = document.getElementById('casinoBetInput');
            if (document.activeElement !== inp) inp.value = casinoBet;

            let stage = '', payout = '';
            if (casinoGame === 'coin') {
                stage = `<div id="coinFace" class="text-6xl leading-none">🪙</div>
                    <div class="grid grid-cols-2 gap-2 w-full">
                        <button onclick="casinoCoin('h')" class="py-2.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-900 font-black text-sm transition">🙂 앞면</button>
                        <button onclick="casinoCoin('t')" class="py-2.5 rounded-xl bg-indigo-400 hover:bg-indigo-300 text-slate-900 font-black text-sm transition">🌙 뒷면</button>
                    </div>`;
                payout = '앞/뒤를 맞히면 배팅액의 <b>1.9배</b>를 돌려받아요. (확률 50%)';
            } else if (casinoGame === 'slot') {
                stage = `<div class="flex gap-2 text-5xl leading-none"><span id="reel0">🎰</span><span id="reel1">🎰</span><span id="reel2">🎰</span></div>
                    <button onclick="casinoSlot()" class="w-full py-2.5 rounded-xl bg-rose-500 hover:bg-rose-400 text-white font-black text-sm transition">🎰 레버 당기기</button>`;
                payout = '7️⃣7️⃣7️⃣ <b>×25</b> · 같은 그림 3개 <b>×9</b> · 2개 일치 <b>본전(×1)</b> · 모두 다르면 꽝';
            } else {
                stage = `<div id="rouletteFace" class="text-2xl font-black leading-none h-8">🎡</div>
                    <button onclick="casinoRoulette()" class="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-black text-sm transition">🎡 룰렛 돌리기</button>`;
                payout = ROULETTE.map(r => `${r.t} (${r.w}%)`).join(' · ');
            }
            document.getElementById('casinoStage').innerHTML = stage;
            document.getElementById('casinoPayout').innerHTML = payout;
            document.getElementById('casinoLog').innerHTML = casinoLog.map(l => `<div>${l}</div>`).join('');
        }

        function casinoSetButtons(disabled) {
            document.querySelectorAll('#casinoStage button, #casinoBetChips button, #casinoTabs button').forEach(b => {
                b.disabled = disabled;
                b.classList.toggle('opacity-50', disabled);
            });
        }
        function casinoRefreshMeta() {
            document.getElementById('casinoCoins').textContent = `🪙 ${profile.coins}`;
            document.getElementById('casinoLog').innerHTML = casinoLog.map(l => `<div>${l}</div>`).join('');
            if (casinoBet > profile.coins) {
                casinoBet = Math.max(CASINO_MIN_BET, profile.coins);
                document.getElementById('casinoBetInput').value = casinoBet;
            }
            casinoSetButtons(false);
        }

        // 배팅액 차감 (성공하면 배팅액, 실패하면 0)
        function casinoTake() {
            if (casinoBusy) return 0;
            const bet = Math.floor(casinoBet);
            if (!(bet >= CASINO_MIN_BET)) { showToast(`최소 배팅은 ${CASINO_MIN_BET} 코인이에요.`); return 0; }
            if (bet > profile.coins) { showToast('코인이 부족해요! 라운드에서 점수를 더 모아오세요 🙂'); return 0; }
            casinoBusy = true;
            profile.coins -= bet;
            saveProfile();
            renderProfileBtn();
            document.getElementById('casinoCoins').textContent = `🪙 ${profile.coins}`;
            document.getElementById('casinoResult').textContent = '';
            casinoSetButtons(true);
            return bet;
        }

        function casinoPay(bet, mult, label) {
            const win = Math.floor(bet * mult);
            profile.coins += win;
            saveProfile();
            renderProfileBtn();
            const net = win - bet;
            const res = document.getElementById('casinoResult');
            res.className = 'text-center text-sm font-black min-h-[24px] mt-3 ' + (net > 0 ? 'text-emerald-300' : (net === 0 ? 'text-slate-200' : 'text-rose-300'));
            res.textContent = net > 0 ? `🎉 +${net} 코인 획득!` : (net === 0 ? '😐 본전이에요!' : `😢 ${net} 코인...`);
            casinoLog.unshift(`${label} → ${net > 0 ? '+' : ''}${net}`);
            if (casinoLog.length > 6) casinoLog.pop();
            casinoBusy = false;
            casinoRefreshMeta();
        }

        function casinoCoin(pick) {
            const bet = casinoTake();
            if (!bet) return;
            const face = document.getElementById('coinFace');
            let n = 0;
            const iv = setInterval(() => { if (face) face.textContent = (n++ % 2) ? '🙂' : '🌙'; }, 90);
            setTimeout(() => {
                clearInterval(iv);
                const heads = casinoRand() < 0.5;
                if (face) face.textContent = heads ? '🙂' : '🌙';
                casinoPay(bet, (heads ? 'h' : 't') === pick ? 1.9 : 0, `동전 ${heads ? '앞' : '뒤'}`);
            }, 1100);
        }

        function casinoSlot() {
            const bet = casinoTake();
            if (!bet) return;
            const pick = () => SLOT_SYMBOLS[Math.floor(casinoRand() * SLOT_SYMBOLS.length)];
            const final = [pick(), pick(), pick()];
            const els = [0, 1, 2].map(i => document.getElementById('reel' + i));
            const ivs = els.map(el => setInterval(() => { if (el) el.textContent = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)]; }, 70));
            [0, 1, 2].forEach(i => setTimeout(() => { clearInterval(ivs[i]); if (els[i]) els[i].textContent = final[i]; }, 700 + i * 350));
            setTimeout(() => {
                const [a, b, c] = final;
                let mult = 0, label = '슬롯 꽝';
                if (a === b && b === c) { mult = a === '7️⃣' ? 25 : 9; label = a === '7️⃣' ? '슬롯 777 🎉' : '슬롯 3개 일치'; }
                else if (a === b || b === c || a === c) { mult = 1; label = '슬롯 2개 일치'; }
                casinoPay(bet, mult, label);
            }, 700 + 2 * 350 + 150);
        }

        function casinoRoulette() {
            const bet = casinoTake();
            if (!bet) return;
            const face = document.getElementById('rouletteFace');
            const iv = setInterval(() => { if (face) face.textContent = ROULETTE[Math.floor(Math.random() * ROULETTE.length)].t; }, 80);
            setTimeout(() => {
                clearInterval(iv);
                let r = casinoRand() * ROULETTE.reduce((s, x) => s + x.w, 0), hit = ROULETTE[0];
                for (const o of ROULETTE) { if (r < o.w) { hit = o; break; } r -= o.w; }
                if (face) face.textContent = hit.t;
                casinoPay(bet, hit.m, `룰렛 ${hit.t}`);
            }, 1400);
        }

        function openScoreHelp() { document.getElementById('scoreHelpModal').classList.remove('hidden'); }
        function closeScoreHelp() { document.getElementById('scoreHelpModal').classList.add('hidden'); }

        renderProfileBtn();
        // 마지막으로 쓴 닉네임(아이디)의 코인·아이템을 미리 불러와요
        try {
            const lastNick = localStorage.getItem('wordle_nick');
            if (lastNick) {
                document.getElementById('nicknameInput').value = lastNick;
                switchProfile(lastNick);
            }
        } catch (e) {}


// 초기 자모 사전은 필요한 길이만 다운로드합니다. (브라우저 캐시 사용)
ensureDictionaryForLength(wordLength).catch(() => showToast("사전 로딩 실패. 인터넷 연결을 확인하세요."));
// 초기화
initBoard();
applyTileSkin();
