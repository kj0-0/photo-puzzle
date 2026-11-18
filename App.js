import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Image, Modal, PanResponder, Platform, Pressable, ScrollView,
  StyleSheet, Text, View, useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { ClipPath, Defs, G, Image as SvgImage, Path } from 'react-native-svg';

// ───── 기본 제공 사진 (Lorem Picsum / Unsplash 라이선스, 1024×1024) ─────
const PHOTOS = [
  { key: 'flower-pink', name: '분홍 꽃', src: require('./assets/photos/106.jpg') },
  { key: 'puppy-blanket', name: '담요 속 강아지', src: require('./assets/photos/1025.jpg'), focus: 0.1 },
  { key: 'grapes', name: '포도 한 송이', src: require('./assets/photos/674.jpg') },
  { key: 'waterfall', name: '숲속 폭포', src: require('./assets/photos/1039.jpg') },
  { key: 'flower-purple', name: '보라색 꽃', src: require('./assets/photos/152.jpg') },
  { key: 'puppy-black', name: '까만 강아지', src: require('./assets/photos/237.jpg') },
  { key: 'lake', name: '산과 호수', src: require('./assets/photos/1043.jpg'), focus: 0.85 },
  { key: 'fjord', name: '푸른 강', src: require('./assets/photos/1015.jpg') },
];

const SOUNDS = {
  pick: require('./assets/sounds/pick.wav'),
  snap: require('./assets/sounds/snap.wav'),
  win: require('./assets/sounds/win.wav'),
};

// ───── 단계 설계 (어르신용: 천천히 어려워짐, 회전 없음) ─────
// n: 가로세로 조각 수, guide: 판에 깔리는 흐린 밑그림 진하기
const LEVELS = [
  { n: 2, guide: 0.45 },
  { n: 3, guide: 0.45 },
  { n: 3, guide: 0.25 },
  { n: 4, guide: 0.3 },
  { n: 4, guide: 0.15 },
  { n: 5, guide: 0.2 },
  { n: 5, guide: 0.1 },
];
const levelCfg = (lv) => LEVELS[Math.min(lv, LEVELS.length) - 1];
const TRAY_MAX = 8; // 판 아래에 한 번에 꺼내 두는 조각 수

const C = {
  // 흰 바탕 + 검정 글자 + 형광 연두 포인트 (빨강 계열은 쓰지 않음)
  // 연두 위에는 흰 글자 대신 검정 글자를 써서 어르신 눈에도 또렷하게
  bg: '#ffffff', card: '#ffffff', ink: '#111111', muted: '#4a4a4a',
  accent: '#c6f432', onAccent: '#111111', line: '#dedede', board: '#f2f2f0', soft: '#f3fcd6', tray: '#f5f6f2',
};

const fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}분 ${s % 60}초` : `${s}초`;
};
const buzz = (kind) => {
  try {
    if (kind === 'win') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    else Haptics.impactAsync(kind === 'snap' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light);
  } catch {}
};

// ───── 기록 저장 ─────
const STORE_KEY = 'photo-puzzle-progress-v1';
const DEFAULT_PROGRESS = { unlocked: 1, level: 1, done: {}, days: {}, sound: true, resume: null };
// resume: 하다 만 퍼즐 { key, level, edges, locked:[조각 번호] } — 다 맞추면 null
const ALBUM_KEY = 'photo-puzzle-album-v1'; // 앨범 사진(작게 줄인 data URI)은 따로 저장
const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function streakOf(days) {
  const d = new Date();
  if (!days[dayKey(d)]) d.setDate(d.getDate() - 1); // 오늘 아직 안 했으면 어제부터 셈
  let n = 0;
  while (days[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

// ───── 직소 조각 모양 ─────
// 퍼즐 전체의 이음새: +1이면 위/왼쪽 조각이 볼록, -1이면 오목
function makeEdges(n) {
  const r = () => (Math.random() < 0.5 ? 1 : -1);
  return {
    h: Array.from({ length: n - 1 }, () => Array.from({ length: n }, r)), // 가로 이음새 (행 사이)
    v: Array.from({ length: n }, () => Array.from({ length: n - 1 }, r)), // 세로 이음새 (열 사이)
  };
}

// 한 변의 볼록/오목 곡선 (u: 변 방향 0~1, v: 바깥쪽 높이 비율)
const TAB = [
  [[0.35, 0], [0.40, 0.05], [0.37, 0.10]],
  [[0.32, 0.20], [0.40, 0.26], [0.50, 0.26]],
  [[0.60, 0.26], [0.68, 0.20], [0.63, 0.10]],
  [[0.60, 0.05], [0.65, 0], [0.65, 0]],
];

function edgePath(x0, y0, x1, y1, sign, L) {
  const dx = x1 - x0, dy = y1 - y0;
  const nx = dy / L, ny = -dx / L; // 시계방향 진행 시 바깥 법선
  const pt = ([u, v]) => `${(x0 + u * dx + v * sign * nx * L).toFixed(2)},${(y0 + u * dy + v * sign * ny * L).toFixed(2)}`;
  if (!sign) return `L${x1},${y1}`;
  return `L${pt([0.35, 0])}` + TAB.map((seg) => `C${seg.map(pt).join(' ')}`).join('') + `L${x1},${y1}`;
}

function piecePath(id, n, edges, tile, pad) {
  const r = Math.floor(id / n), c = id % n;
  const top = r === 0 ? 0 : -edges.h[r - 1][c];
  const bottom = r === n - 1 ? 0 : edges.h[r][c];
  const left = c === 0 ? 0 : -edges.v[r][c - 1];
  const right = c === n - 1 ? 0 : edges.v[r][c];
  const a = pad, b = pad + tile;
  return `M${a},${a}` +
    edgePath(a, a, b, a, top, tile) +
    edgePath(b, a, b, b, right, tile) +
    edgePath(b, b, a, b, bottom, tile) +
    edgePath(a, b, a, a, left, tile) + 'Z';
}

// ───── 웹: 사진첩 사진을 1024 정사각형 JPEG로 ─────
// 아이폰 사진(HEIC/HEIF)은 크롬이 못 열어서 JPEG로 바꾼 뒤 처리.
// 아주 큰 사진(4800만 화소 등)도 폰 브라우저 한도에 걸리지 않게 바로 1024 크기로 줄여 그림.
const isHeic = (f) => /hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name || '');

function loadWebImage(blob) {
  return new Promise((ok, fail) => {
    const url = URL.createObjectURL(blob);
    const im = new window.Image();
    im.onload = () => ok(im);
    im.onerror = () => fail(new Error('decode'));
    im.src = url;
  });
}

async function webPhotoToSquare(file) {
  let im;
  try {
    im = await loadWebImage(file); // 사파리는 HEIC도 바로 열림
  } catch (e) {
    if (!isHeic(file)) throw e;
    const { heicTo } = await import('heic-to');
    const jpg = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.9 });
    im = await loadWebImage(jpg);
  }
  const w = im.naturalWidth, h = im.naturalHeight, s = Math.min(w, h);
  const out = Math.min(1024, s);
  const cv = document.createElement('canvas');
  cv.width = cv.height = out;
  cv.getContext('2d').drawImage(im, (w - s) / 2, (h - s) / 2, s, s, 0, 0, out, out);
  URL.revokeObjectURL(im.src);
  return cv.toDataURL('image/jpeg', 0.85);
}

// ───── 앱 ─────
export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

// 폰 위쪽 상태표시줄(시계·배터리)과 겹치지 않게 여백을 둠.
// 웹 미리보기에는 상태표시줄 값이 없어서 갤럭시(S24 기준 약 32dp)와 비슷하게 맞춤.
const WEB_STATUS_BAR = 32;

function Main() {
  const insets = useSafeAreaInsets();
  const safePad = {
    paddingTop: Platform.OS === 'web' ? Math.max(insets.top, WEB_STATUS_BAR) : insets.top,
    paddingBottom: insets.bottom,
  };
  const [photo, setPhoto] = useState(null);
  const [level, setLevel] = useState(1); // 지금 하고 있는 퍼즐의 단계
  const [init, setInit] = useState(null); // 이어서 하기일 때 이미 맞춘 조각 정보
  const [albumSrc, setAlbumSrc] = useState(null);
  const [notice, setNotice] = useState(null); // 사진 준비 중/실패 안내 { busy, text }
  const [round, setRound] = useState(0);
  const [showBasic, setShowBasic] = useState(false); // 첫 화면에서 '기본 사진' 목록을 펼쳤는지
  const [prog, setProg] = useState(null); // 저장된 기록 (불러오기 전엔 null)

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
    AsyncStorage.getItem(STORE_KEY)
      .then((s) => setProg({ ...DEFAULT_PROGRESS, ...(s ? JSON.parse(s) : {}) }))
      .catch(() => setProg(DEFAULT_PROGRESS));
    AsyncStorage.getItem(ALBUM_KEY).then((u) => u && setAlbumSrc({ uri: u })).catch(() => {});
  }, []);

  function play(ph, lv, resume = null) {
    setPhoto(ph);
    setLevel(lv);
    setInit(resume);
    setRound((r) => r + 1);
  }

  function resumeGame() {
    const r = prog.resume;
    const src = r.key === 'album' ? albumSrc : PHOTOS.find((x) => x.key === r.key)?.src;
    if (!src) return;
    play({ key: r.key, src }, r.level, r);
  }

  // 조각을 맞출 때마다 하던 곳 저장
  function saveProgress(edges, locked) {
    update((p) => ({ ...p, resume: { key: photo.key, level, edges, locked } }));
  }

  function update(fn) {
    setProg((p) => {
      const next = fn(p);
      AsyncStorage.setItem(STORE_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }

  // 내 앨범에서 고르기 (선택 사항)
  // 폰: 기본 사진첩(갤러리) 화면이 열림
  async function pickAlbum() {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (res.canceled) return;
    await withNotice(() => startFromPhoto(res.assets[0]));
  }

  // 사진을 준비하는 동안 안내를 띄우고, 실패하면 쉬운 말로 알려 줌
  async function withNotice(job) {
    setNotice({ busy: true, text: '사진을 퍼즐로 만들고 있어요…' });
    try {
      await job();
      setNotice(null);
    } catch (e) {
      console.warn('사진 처리 실패', e?.message ?? JSON.stringify(e));
      setNotice({ busy: false, text: '이 사진은 열 수 없어요.\n다른 사진을 골라 주세요.' });
    }
  }

  // 웹 미리보기: 버튼 위에 겹친 파일 선택 칸에서 고른 사진
  async function pickWebFile(file) {
    if (!file) return;
    await withNotice(async () => {
      const uri = await webPhotoToSquare(file);
      savePhotoAndPlay(uri);
    });
  }

  // 가운데를 정사각형으로 잘라 퍼즐 시작
  async function startFromPhoto(a) {
    const s = Math.min(a.width, a.height);
    const out = await manipulateAsync(
      a.uri,
      [
        { crop: { originX: (a.width - s) / 2, originY: (a.height - s) / 2, width: s, height: s } },
        { resize: { width: 1024, height: 1024 } },
      ],
      { compress: 0.85, format: SaveFormat.JPEG, base64: true },
    );
    savePhotoAndPlay(`data:image/jpeg;base64,${out.base64}`);
  }

  // 다음에 '이어서 하기'로 다시 불러올 수 있게 그림 자체를 저장하고 퍼즐 시작
  function savePhotoAndPlay(uri) {
    AsyncStorage.setItem(ALBUM_KEY, uri).catch(() => {});
    setAlbumSrc({ uri });
    play({ key: 'album', src: { uri } }, prog.level);
  }

  function cleared(level) {
    update((p) => ({
      ...p,
      unlocked: Math.min(LEVELS.length, Math.max(p.unlocked, level + 1)),
      level: Math.min(LEVELS.length, Math.max(p.level, level + 1)), // 새 그림은 다음 단계로 시작
      resume: null,
      done: photo.key === 'album' ? p.done : { ...p.done, [photo.key]: Math.max(p.done[photo.key] || 0, level) },
      days: { ...p.days, [dayKey()]: (p.days[dayKey()] || 0) + 1 },
    }));
  }

  if (!prog) return <View style={[styles.safe, safePad]} />;

  return (
    <View style={[styles.safe, safePad]}>
      <StatusBar style="dark" />
      <View style={styles.app}>
        {photo ? (
          <Game
            key={`${photo.key}-${level}-${round}`}
            photo={photo.src}
            level={level}
            init={init}
            sound={prog.sound}
            onProgress={saveProgress}
            onNext={() => play(photo, Math.min(level + 1, LEVELS.length))}
            onRetry={() => play(photo, level)}
            onLevel={(lv) => { update((p) => ({ ...p, level: lv })); play(photo, lv); }}
            onCleared={cleared}
            onExit={() => setPhoto(null)}
          />
        ) : (
          <Start
            prog={prog}
            albumSrc={albumSrc}
            onChoose={(ph) => play(ph, prog.level)}
            onResume={resumeGame}
            onAlbum={pickAlbum}
            onWebFile={pickWebFile}
            showBasic={showBasic}
            onBasic={setShowBasic}
            onSound={() => update((p) => ({ ...p, sound: !p.sound }))}
          />
        )}
      </View>

      {/* 사진 준비 중 / 열 수 없는 사진 안내 */}
      <Modal transparent visible={!!notice} animationType="fade">
        <View style={styles.modalBg}>
          <View style={[styles.sheet, { alignItems: 'stretch' }]}>
            <Text style={[styles.h2, { textAlign: 'center', fontSize: 21, lineHeight: 30 }]}>{notice?.text}</Text>
            {notice && !notice.busy && <Btn primary label="확인" onPress={() => setNotice(null)} />}
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ───── 첫 화면 ─────
function Start({ prog, albumSrc, onChoose, onResume, onAlbum, onWebFile, onSound, showBasic, onBasic }) {
  // 두 줄 배치: 화면 폭에 맞춰 정사각형 크기를 정확히 계산
  const { width } = useWindowDimensions();
  // 한 줄에 한 장씩, 가로로 넓은 사진 카드 (높이는 가로의 절반)
  const cardW = Math.min(width, 600) - 32 - 4; // 테두리 두께 제외
  const thumbH = Math.round(cardW * 0.5);
  const today = prog.days[dayKey()] || 0;
  const streak = streakOf(prog.days);
  // 하다 만 퍼즐이 있으면 '이어서 하기'
  const r = prog.resume;
  const rPhoto = r && (r.key === 'album' ? albumSrc && { name: '내 앨범 사진', src: albumSrc } : PHOTOS.find((x) => x.key === r.key));
  const rTotal = r ? levelCfg(r.level).n ** 2 : 0;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 16, paddingBottom: 24 }}>
      <View style={styles.titleRow}>
        <Text style={styles.h1}>나만의 퍼즐</Text>
        <Pressable onPress={onSound} style={styles.soundBtn} hitSlop={8}>
          <Text style={styles.soundText}>{prog.sound ? '🔊 소리 켬' : '🔇 소리 끔'}</Text>
        </Pressable>
      </View>

      {/* 오늘의 기록 — 완성한 적이 있을 때만 */}
      {(today > 0 || streak >= 2) && (
        <View style={styles.todayCard}>
          {today > 0 && <Text style={styles.todayBig}>오늘 {today}번 완성했어요 👏</Text>}
          {streak >= 2 && <Text style={styles.todaySub}>{streak}일째 꾸준히 하고 계세요 🌱</Text>}
        </View>
      )}

      {rPhoto && !showBasic && (
        <Pressable onPress={onResume}
          style={({ pressed }) => [styles.resume, pressed && { transform: [{ scale: 0.98 }] }]}>
          <Image source={rPhoto.src} resizeMode="cover" style={styles.resumeImg} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.resumeTitle}>이어서 하기 ▶</Text>
            <Text style={styles.resumeSub}>{rPhoto.name}</Text>
            <Text style={styles.resumeSub}>{rTotal}조각 중 {r.locked.length}개 맞췄어요</Text>
          </View>
        </Pressable>
      )}

      {!showBasic ? (
        <>
          <Text style={styles.sectionTitle}>{rPhoto ? '새 그림으로 하기' : '어떤 사진으로 퍼즐을 만들까요?'}</Text>
          <ChoiceBtn icon="📱" title="내 앨범에서 사진 고르기" sub="가족 사진으로 퍼즐을 만들어요"
            onPress={onAlbum} onWebFile={onWebFile} />
          <ChoiceBtn icon="🖼" title="기본 사진 사용하기" sub="꽃, 강아지, 풍경 그림 8장" onPress={() => onBasic(true)} />
        </>
      ) : (
        <>
          <View style={styles.basicHead}>
            <Pressable onPress={() => onBasic(false)} hitSlop={10} style={styles.backBtn}>
              <Text style={styles.backText}>‹ 이전으로</Text>
            </Pressable>
            <Text style={styles.sectionTitle}>마음에 드는 그림을 눌러 주세요</Text>
          </View>
          <View style={styles.photoGrid}>
            {PHOTOS.map((p) => (
              <Pressable key={p.key} onPress={() => onChoose(p)}
                style={({ pressed }) => [styles.photoCard, pressed && { transform: [{ scale: 0.97 }] }]}>
                {/* 정사각형 사진에서 보여줄 부분(focus: 0 위 ~ 1 아래)을 골라 가로로 자름 */}
                <View style={{ height: thumbH, overflow: 'hidden' }}>
                  <Image source={p.src} style={{ width: cardW, height: cardW, marginTop: -(cardW - thumbH) * (p.focus ?? 0.5) }} />
                </View>
                {prog.done[p.key] ? <Text style={styles.doneBadge}>✓ 완성</Text> : null}
                <Text style={styles.photoName}>{p.name}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}

function ChoiceBtn({ icon, title, sub, onPress, onWebFile }) {
  // 웹에서는 브라우저가 직접 누른 것으로 인정하도록 투명한 파일 선택 칸을 버튼 위에 겹침
  const webInput = Platform.OS === 'web' && onWebFile;
  return (
    <Pressable onPress={webInput ? undefined : onPress}
      style={({ pressed }) => [styles.choice, pressed && { transform: [{ scale: 0.98 }], backgroundColor: C.soft }]}>
      <Text style={styles.choiceIcon}>{icon}</Text>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={styles.choiceTitle}>{title}</Text>
        <Text style={styles.choiceSub} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>{sub}</Text>
      </View>
      <Text style={styles.choiceArrow}>›</Text>
      {webInput && (
        <input type="file" accept="image/*" aria-label={title}
          onChange={(e) => { onWebFile(e.target.files?.[0]); e.target.value = ''; }}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }} />
      )}
    </Pressable>
  );
}

// ───── 게임 ─────
function Game({ photo, level, init, sound, onProgress, onNext, onRetry, onLevel, onCleared, onExit }) {
  const [pickLevel, setPickLevel] = useState(false); // 단계 고르기 창
  const { n: N, guide: GUIDE } = levelCfg(level);
  const total = N * N;
  const [edges] = useState(() => init?.edges ?? makeEdges(N));
  const [geom, setGeom] = useState(null); // 판·대기 공간 크기와 위치
  // 조각: { id, state: 'queue'|'tray'|'locked', slot } — 위치는 posRef의 Animated 값
  const [pieces, setPieces] = useState([]);
  const [order, setOrder] = useState([]); // 그리는 순서 (마지막이 맨 위)
  const [start] = useState(Date.now());
  const [doneAt, setDoneAt] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [peek, setPeek] = useState(false);
  const [dragging, setDragging] = useState(null);
  const posRef = useRef({}); // id → Animated.ValueXY (조각 그림 좌상단)

  const players = {
    pick: useAudioPlayer(SOUNDS.pick),
    snap: useAudioPlayer(SOUNDS.snap),
    win: useAudioPlayer(SOUNDS.win),
  };
  const play = (k) => {
    if (!sound) return;
    try { players[k].seekTo(0); players[k].play(); } catch {}
  };

  function onLayout(e) {
    if (geom) return;
    const { width: W, height: H } = e.nativeEvent.layout;
    const boardSize = Math.floor(Math.min(W, 520, H * 0.72)); // 폰 가로 끝까지 꽉 채움
    const tile = boardSize / N;
    const pad = tile * 0.27;
    const bx = (W - boardSize) / 2, by = 4;
    const trayTop = by + boardSize + 10;
    const trayH = H - trayTop;

    // 대기 공간: 조각을 최대한 크게, 최대 TRAY_MAX개까지. 조각끼리는 절대 겹치지 않게
    // 한 칸 = 볼록 튀어나온 부분(양쪽 각 0.26)까지 포함한 조각 크기(1.52배) + 여백 4
    // → 이웃 조각의 볼록한 부분이 마주 봐도 닿지 않는 가장 큰 크기
    const want = Math.min(total, TRAY_MAX);
    const cellOf = (sc) => tile * sc * 1.52 + 4;
    let s = 0.95, cols = 1, rows = 1;
    for (; s >= 0.25; s -= 0.005) {
      cols = Math.max(1, Math.floor(W / cellOf(s)));
      rows = Math.max(1, Math.floor(trayH / cellOf(s)));
      if (cols * rows >= want) break;
    }
    const count = Math.min(want, cols * rows);
    const usedRows = Math.ceil(count / cols);
    const cellW = W / Math.min(cols, count);
    const cellH = Math.min(trayH / usedRows, cellOf(s) * 1.15); // 남는 높이는 살짝만 나눠 씀
    const slots = [...Array(count).keys()].map((k) => {
      const col = k % cols, row = Math.floor(k / cols);
      const inRow = Math.min(cols, count - row * cols);
      const rowW = inRow * cellW;
      return {
        x: (W - rowW) / 2 + col * cellW + cellW / 2 - tile / 2 - pad,
        y: trayTop + row * cellH + cellH / 2 - tile / 2 - pad,
      };
    });

    const g = { W, H, boardSize, tile, pad, bx, by, trayTop, trayScale: s, slots };
    setGeom(g);

    // 이어서 하기: 이미 맞춘 조각은 제자리에 고정
    const done = new Set(init?.locked ?? []);
    const ps = [];
    done.forEach((id) => {
      posRef.current[id] = new Animated.ValueXY({
        x: bx + (id % N) * tile - pad, y: by + Math.floor(id / N) * tile - pad,
      });
      ps.push({ id, state: 'locked', slot: null, q: -1 });
    });
    // 남은 조각은 순서를 섞어서 앞의 몇 개만 대기 공간에 꺼내 둠
    const queue = [...Array(total).keys()].filter((id) => !done.has(id)).sort(() => Math.random() - 0.5);
    queue.forEach((id, i) => {
      const inTray = i < slots.length;
      const at = inTray ? slots[i] : slots[0];
      posRef.current[id] = new Animated.ValueXY(at);
      ps.push({ id, state: inTray ? 'tray' : 'queue', slot: inTray ? i : null, q: i });
    });
    setPieces(ps);
    setOrder([...done, ...queue]);
  }

  // 맞춘 조각이 바뀔 때마다 저장 (다 맞추면 저장하지 않음 — 완성 기록이 대신함)
  const lockedKey = pieces.filter((q) => q.state === 'locked').map((q) => q.id).join(',');
  useEffect(() => {
    if (!pieces.length || pieces.every((q) => q.state === 'locked')) return;
    onProgress(edges, lockedKey ? lockedKey.split(',').map(Number) : []);
  }, [lockedKey, pieces.length]);

  const target = (id) => ({
    x: geom.bx + (id % N) * geom.tile - geom.pad,
    y: geom.by + Math.floor(id / N) * geom.tile - geom.pad,
  });

  function grab(id) {
    setDragging(id);
    play('pick');
    setOrder((o) => [...o.filter((x) => x !== id), id]);
  }

  function lock(id) {
    const pos = posRef.current[id];
    Animated.spring(pos, { toValue: target(id), useNativeDriver: false, speed: 30, bounciness: 6 }).start();
    buzz('snap');
    play('snap');
    setPieces((ps) => {
      const me = ps.find((q) => q.id === id);
      const freeSlot = me.slot;
      // 대기 중인 다음 조각을 빈 자리로
      const nextQ = ps.filter((q) => q.state === 'queue').sort((a, b) => a.q - b.q)[0];
      const next = ps.map((q) => {
        if (q.id === id) return { ...q, state: 'locked', slot: null };
        if (nextQ && q.id === nextQ.id) {
          posRef.current[q.id].setValue(geom.slots[freeSlot]);
          return { ...q, state: 'tray', slot: freeSlot };
        }
        return q;
      });
      if (next.every((q) => q.state === 'locked')) setTimeout(win, 0);
      return next;
    });
    setOrder((o) => [id, ...o.filter((v) => v !== id)]); // 맞은 조각은 맨 아래로
  }

  function drop(id, x, y) {
    setDragging(null);
    const t = target(id);
    if (Math.hypot(x - t.x, y - t.y) < geom.tile * 0.55) return lock(id);
    // 제자리가 아니면 대기 공간 원래 자리로 스르르 돌아감
    const me = pieces.find((q) => q.id === id);
    Animated.spring(posRef.current[id], { toValue: geom.slots[me.slot], useNativeDriver: false, speed: 14, bounciness: 4 }).start();
  }

  function help() {
    if (doneAt || !geom) return;
    const tray = pieces.filter((q) => q.state === 'tray');
    if (!tray.length) return;
    const p = tray[Math.floor(Math.random() * tray.length)];
    setOrder((o) => [...o.filter((v) => v !== p.id), p.id]);
    lock(p.id);
  }

  function win() {
    setDoneAt(Date.now());
    onCleared(level);
    setTimeout(() => { buzz('win'); play('win'); setShowModal(true); }, 500);
  }

  const next = levelCfg(level + 1);
  const isMax = level >= LEVELS.length;
  const placed = pieces.filter((p) => p.state === 'locked').length;
  const waiting = pieces.filter((p) => p.state === 'queue').length;
  const byId = Object.fromEntries(pieces.map((p) => [p.id, p]));

  return (
    <View style={{ flex: 1, gap: 10 }}>
      <View style={styles.gameTop}>
        <Pressable onPress={onExit} hitSlop={10} style={styles.backBtn}>
          <Text style={styles.backText}>‹ 사진 바꾸기</Text>
        </Pressable>
        {/* 누르면 단계를 고를 수 있음 */}
        <Pressable onPress={() => setPickLevel(true)} hitSlop={10}
          style={({ pressed }) => [styles.levelBtn, pressed && { backgroundColor: C.soft }]}>
          <Text style={styles.gameLevel}>{`${level}단계 ▾`}</Text>
        </Pressable>
      </View>

      <Modal transparent visible={pickLevel} animationType="fade" onRequestClose={() => setPickLevel(false)}>
        <Pressable style={styles.modalBg} onPress={() => setPickLevel(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={[styles.h2, { textAlign: 'center' }]}>단계 고르기</Text>
            <Text style={[styles.sub, { textAlign: 'center' }]}>숫자가 클수록 조각이 많아요</Text>
            <View style={styles.levelGrid}>
              {LEVELS.map((cfg, i) => {
                const lv = i + 1, on = lv === level;
                return (
                  <Pressable key={lv}
                    onPress={() => { setPickLevel(false); if (!on) onLevel(lv); }}
                    style={({ pressed }) => [styles.levelItem, on && styles.levelItemOn, pressed && { transform: [{ scale: 0.97 }] }]}>
                    <Text style={[styles.levelItemBig, on && { color: '#fff' }]}>{`${lv}단계`}</Text>
                    <Text style={[styles.levelItemSub, on && { color: '#fff' }]}>{cfg.n * cfg.n}조각</Text>
                  </Pressable>
                );
              })}
            </View>
            <Btn label="닫기" onPress={() => setPickLevel(false)} />
          </Pressable>
        </Pressable>
      </Modal>

      {/* 진행 막대 */}
      <View>
        <View style={styles.progressBg}>
          <View style={[styles.progressFill, { width: `${(placed / total) * 100}%` }]} />
        </View>
        {placed === 0 ? (
          <Text style={[styles.progressText, { color: C.ink }]}>👇 조각을 끌어서 그림 위에 놓아 주세요</Text>
        ) : (
          <Text style={styles.progressText}>
            {placed} / {total} 조각 맞췄어요
            {waiting > 0 ? <Text style={styles.waitText}>{`  ·  남은 조각 ${waiting}개`}</Text> : null}
          </Text>
        )}
      </View>

      {/* 놀이 공간: 위는 퍼즐판, 아래는 꺼내 둔 조각들 */}
      <View style={{ flex: 1, marginHorizontal: -16 }} onLayout={onLayout}>
        {geom && (
          <>
            <View style={[styles.board, { left: geom.bx, top: geom.by, width: geom.boardSize, height: geom.boardSize }]}>
              {/* 흐린 밑그림: 어디에 놓을지 힌트 */}
              <Image source={photo} style={{ position: 'absolute', width: geom.boardSize, height: geom.boardSize, opacity: GUIDE }} />
              {/* 퍼즐판 바탕: 조각이 들어갈 자리를 직소 모양 선으로 */}
              <Svg width={geom.boardSize} height={geom.boardSize} style={{ position: 'absolute' }}>
                {[...Array(total).keys()].map((id) => (
                  <G key={`slot${id}`} transform={`translate(${(id % N) * geom.tile - geom.pad},${Math.floor(id / N) * geom.tile - geom.pad})`}>
                    <Path d={piecePath(id, N, edges, geom.tile, geom.pad)} fill="none"
                      stroke="#9b9b9b" strokeWidth={2} />
                  </G>
                ))}
              </Svg>
            </View>

            <View style={[styles.tray, { top: geom.trayTop - 4 }]} />

            {order.map((id) => byId[id] && byId[id].state !== 'queue' && (
              <Piece
                key={id}
                p={byId[id]}
                pos={posRef.current[id]}
                geom={geom}
                N={N}
                edges={edges}
                photo={photo}
                clipId={`c${level}-${id}`}
                lifted={dragging === id}
                onGrab={grab}
                onDrop={drop}
              />
            ))}

            {peek && (
              <Image source={photo} pointerEvents="none"
                style={{ position: 'absolute', left: geom.bx, top: geom.by, width: geom.boardSize, height: geom.boardSize }} />
            )}
          </>
        )}
      </View>

      <View style={styles.controls}>
        <Btn style={{ flex: 1 }} label={peek ? '👀 그림 닫기' : '👀 그림 보기'} onPress={() => setPeek((v) => !v)} />
        <Btn style={{ flex: 1 }} label="💡 도와줘요" onPress={help} />
      </View>

      <Modal transparent visible={showModal} animationType="fade">
        <View style={styles.modalBg}>
          <View style={styles.sheet}>
            <Image source={photo} style={styles.doneImg} />
            <Text style={[styles.h2, { textAlign: 'center' }]}>참 잘하셨어요! 🎉</Text>
            <Text style={[styles.sub, { textAlign: 'center', fontSize: 18 }]}>
              {level}단계 그림을 완성했어요{'\n'}{doneAt ? fmt(doneAt - start) : ''} 걸렸어요
            </Text>
            {!isMax && (
              <View style={styles.nextInfo}>
                <Text style={{ color: C.ink, textAlign: 'center', fontSize: 17 }}>
                  다음 단계는 <Text style={{ fontWeight: '800' }}>{next.n * next.n}조각</Text>이에요
                </Text>
              </View>
            )}
            <Btn primary label={isMax ? '한 번 더 하기' : '다음 단계로'} onPress={() => { setShowModal(false); onNext(); }} />
            {!isMax && <Btn label="이 단계 한 번 더" onPress={() => { setShowModal(false); onRetry(); }} />}
            <Btn label="사진 바꾸기" onPress={() => { setShowModal(false); onExit(); }} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ───── 조각 하나 ─────
function Piece({ p, pos, geom, N, edges, photo, clipId, lifted, onGrab, onDrop }) {
  const { tile, pad, boardSize } = geom;
  const size = tile + pad * 2;
  const d = useMemo(() => piecePath(p.id, N, edges, tile, pad), [p.id, N, edges, tile, pad]);
  const locked = p.state === 'locked';

  // 대기 공간에 새로 나올 때 살짝 커지며 나타남
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(appear, { toValue: 1, duration: 260, useNativeDriver: false }).start();
  }, [p.slot]);

  const cb = useRef();
  cb.current = { p, onGrab, onDrop };
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => cb.current.p.state === 'tray',
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      pan.start = { x: pos.x.__getValue(), y: pos.y.__getValue() };
      cb.current.onGrab(cb.current.p.id);
    },
    onPanResponderMove: (_, g) => pos.setValue({ x: pan.start.x + g.dx, y: pan.start.y + g.dy }),
    onPanResponderRelease: (_, g) => cb.current.onDrop(cb.current.p.id, pan.start.x + g.dx, pan.start.y + g.dy),
    onPanResponderTerminate: (_, g) => cb.current.onDrop(cb.current.p.id, pan.start.x + g.dx, pan.start.y + g.dy),
  })).current;

  const cx = p.id % N, cy = Math.floor(p.id / N);
  const baseScale = lifted ? 1.06 : locked ? 1 : geom.trayScale;
  const scale = locked || lifted ? baseScale : Animated.multiply(appear, baseScale);
  return (
    <Animated.View
      {...pan.panHandlers}
      pointerEvents={locked ? 'none' : 'auto'}
      style={[styles.piece, lifted && styles.lifted, {
        width: size, height: size,
        transform: [...pos.getTranslateTransform(), { scale }],
      }]}
    >
      <Svg width={size} height={size}>
        <Defs>
          <ClipPath id={clipId}>
            <Path d={d} />
          </ClipPath>
        </Defs>
        <SvgImage
          href={photo}
          x={pad - cx * tile}
          y={pad - cy * tile}
          width={boardSize}
          height={boardSize}
          clipPath={`url(#${clipId})`}
          preserveAspectRatio="none"
        />
        <Path d={d} fill="none" stroke={locked ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.9)'} strokeWidth={locked ? 0.5 : 2} />
      </Svg>
    </Animated.View>
  );
}

function Btn({ label, primary, style, ...rest }) {
  return (
    <Pressable
      {...rest}
      style={({ pressed }) => [styles.btn, style, primary && styles.btnPrimary, pressed && { transform: [{ scale: 0.97 }] }]}
    >
      <Text style={[styles.btnText, primary && { color: '#ffffff' }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  app: { flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  h1: { fontSize: 30, fontWeight: '800', color: C.ink, letterSpacing: -0.5 },
  h2: { fontSize: 26, fontWeight: '800', color: C.ink },
  sub: { fontSize: 18, color: C.muted, lineHeight: 27 },

  // 첫 화면
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  soundBtn: { backgroundColor: C.card, borderWidth: 2, borderColor: C.line, borderRadius: 26, paddingHorizontal: 16, minHeight: 52, justifyContent: 'center' },
  soundText: { fontSize: 17, fontWeight: '700', color: C.ink },
  todayCard: { backgroundColor: C.soft, borderRadius: 18, padding: 16, gap: 4 },
  todayBig: { fontSize: 20, fontWeight: '800', color: C.ink },
  todaySub: { fontSize: 17, color: C.muted, fontWeight: '600' },
  sectionTitle: { fontSize: 21, fontWeight: '800', color: C.ink, marginTop: 4 },
  photoGrid: { gap: 14 },
  photoCard: { width: '100%', backgroundColor: C.card, borderRadius: 18, borderWidth: 2, borderColor: C.line, overflow: 'hidden' },
  photoName: { fontSize: 19, fontWeight: '800', color: C.ink, textAlign: 'center', paddingVertical: 14 },
  doneBadge: {
    position: 'absolute', top: 8, right: 8, backgroundColor: C.accent, color: C.onAccent, fontWeight: '800',
    fontSize: 17, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, overflow: 'hidden',
  },

  // 게임 화면
  gameTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  resume: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: C.accent, borderRadius: 20, padding: 14 },
  resumeImg: { width: 100, height: 100, borderRadius: 14, backgroundColor: C.soft },
  resumeTitle: { fontSize: 24, fontWeight: '800', color: C.onAccent },
  resumeSub: { fontSize: 17, color: C.onAccent, fontWeight: '600' },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderRadius: 20,
    paddingVertical: 22, paddingHorizontal: 14, borderWidth: 2, borderColor: C.line, minHeight: 104 },
  choiceIcon: { fontSize: 32 },
  choiceTitle: { fontSize: 20, fontWeight: '800', color: C.ink },
  choiceSub: { fontSize: 15, color: C.muted, lineHeight: 22 },
  choiceArrow: { fontSize: 34, color: C.ink, fontWeight: '700' },
  basicHead: { gap: 12, alignItems: 'flex-start' },
  backBtn: { minHeight: 52, paddingHorizontal: 16, borderRadius: 26, borderWidth: 2, borderColor: C.line, backgroundColor: C.card, justifyContent: 'center' },
  backText: { fontSize: 17, fontWeight: '700', color: C.ink },
  gameLevel: { fontSize: 20, fontWeight: '800', color: C.ink },
  levelBtn: { minHeight: 52, paddingHorizontal: 16, borderRadius: 26, borderWidth: 2, borderColor: C.line, backgroundColor: C.card, justifyContent: 'center' },
  levelGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  levelItem: { width: '48%', flexGrow: 1, minHeight: 70, borderRadius: 16, borderWidth: 2, borderColor: C.line, alignItems: 'center', justifyContent: 'center', paddingVertical: 8 },
  levelItemOn: { backgroundColor: C.ink, borderColor: C.ink },
  levelItemBig: { fontSize: 20, fontWeight: '800', color: C.ink },
  levelItemSub: { fontSize: 15, fontWeight: '600', color: C.muted },
  progressBg: { height: 18, borderRadius: 9, backgroundColor: '#ececec', borderWidth: 1, borderColor: '#d4d4d4', overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: C.accent, borderRadius: 9 },
  progressText: { fontSize: 17, fontWeight: '800', color: C.ink, marginTop: 8, textAlign: 'center' },
  board: { position: 'absolute', overflow: 'hidden', backgroundColor: C.board },
  tray: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: C.tray },
  waitText: { fontSize: 15, fontWeight: '600', color: C.muted },
  piece: { position: 'absolute', left: 0, top: 0 },
  lifted: { shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 12 },
  controls: { flexDirection: 'row', gap: 10 },
  btn: {
    minHeight: 64, paddingVertical: 16, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center', backgroundColor: C.card,
    borderWidth: 2, borderColor: C.line, alignItems: 'center',
  },
  btnPrimary: { backgroundColor: C.ink, borderColor: C.ink }, // 가장 중요한 버튼은 검정 + 흰 글자
  btnText: { fontWeight: '800', color: C.ink, fontSize: 18 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  sheet: { backgroundColor: C.card, borderRadius: 22, padding: 20, width: '100%', maxWidth: 380, gap: 10 },
  doneImg: { width: 150, height: 150, borderRadius: 14, alignSelf: 'center' },
  nextInfo: { backgroundColor: C.soft, borderRadius: 12, padding: 12 },
});
