(async function () {
  var SCALE_MODE = "letterbox";
  var DEG_TO_RAD = Math.PI / 180;

  function parseColor(hex, fallback) {
    if (!hex) return fallback;
    var clean = String(hex).trim().replace(/^#/, '');
    var n = parseInt(clean, 16);
    return Number.isFinite(n) ? n : fallback;
  }

  // Web Audio API autónomo (archivos locales + sintetizador SFX)
  var audioCtx = null;
  var audioBuffers = new Map();
  function ensureAudio() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
    return audioCtx;
  }
  function playSynth(preset, busGain) {
    var ctx = ensureAudio();
    if (!ctx || busGain <= 0.001) return;
    var now = ctx.currentTime;
    function tone(type, f1, f2, off, dur, vol) {
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f1, now + off);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), now + off + dur);
      g.gain.setValueAtTime(vol * busGain, now + off);
      g.gain.exponentialRampToValueAtTime(0.001, now + off + dur);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(now + off);
      o.stop(now + off + dur + 0.01);
    }
    if (preset === 'jump') tone('square', 220, 560, 0, 0.16, 0.18);
    else if (preset === 'hit') tone('sawtooth', 170, 55, 0, 0.18, 0.25);
    else if (preset === 'powerup') {
      tone('triangle', 440, 554, 0, 0.08, 0.2);
      tone('triangle', 554, 659, 0.08, 0.08, 0.2);
      tone('triangle', 659, 880, 0.16, 0.14, 0.22);
    } else {
      tone('square', 987.77, 987.77, 0, 0.07, 0.18);
      tone('square', 1318.51, 1318.51, 0.07, 0.16, 0.18);
    }
  }
  function playAudioAsset(assetId, busGain) {
    var ctx = ensureAudio();
    var buf = audioBuffers.get(assetId);
    if (!ctx || !buf || busGain <= 0.001) return;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var g = ctx.createGain();
    g.gain.value = busGain;
    src.connect(g);
    g.connect(ctx.destination);
    src.start(0);
  }

  async function boot() {
    if (window.NexusPortal) {
      await window.NexusPortal.init();
    }

    var resp = await fetch('data/game.json');
    if (!resp.ok) {
      throw new Error('No se pudo cargar data/game.json');
    }
    var gameData = await resp.json();
    var stageW = gameData.settings.width || 1280;
    var stageH = gameData.settings.height || 720;
    var scene = gameData.scenes.find(function (s) { return s.id === gameData.activeSceneId; }) || gameData.scenes[0];

    var buses = gameData.audioBuses || { master: 0.85, music: 0.7, sfx: 0.9, ui: 0.8, muted: {} };
    function getChannelGain(ch) {
      if (buses.muted && (buses.muted.master || buses.muted[ch])) return 0;
      return Math.max(0, Math.min(1, (buses.master || 0.85) * (buses[ch] || 0.85)));
    }

    var host = document.getElementById('nx-stage-wrap');
    var app = new PIXI.Application();
    await app.init({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: parseColor(scene.backgroundColor || gameData.settings.backgroundColor, 0x131b2e),
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      preference: ['webgl', 'canvas']
    });
    host.appendChild(app.canvas);

    // Cargar texturas y sonidos desde assets/
    var textures = new Map();
    var assets = gameData.assets || [];
    for (var i = 0; i < assets.length; i++) {
      var asset = assets[i];
      try {
        if (asset.kind === 'audio' || asset.format === 'wav' || asset.format === 'mp3' || asset.format === 'ogg') {
          var aRes = await fetch(asset.path);
          if (aRes.ok && ensureAudio()) {
            var ab = await aRes.arrayBuffer();
            audioBuffers.set(asset.id, await audioCtx.decodeAudioData(ab));
          }
        } else {
          var tex = await PIXI.Assets.load(asset.path);
          textures.set(asset.id, tex);
        }
      } catch (e) {
        console.warn('Error cargando recurso:', asset.path, e);
      }
    }

    var world = new PIXI.Container();
    var bgRect = new PIXI.Graphics();
    bgRect.rect(0, 0, stageW, stageH);
    bgRect.fill({ color: parseColor(scene.backgroundColor || gameData.settings.backgroundColor, 0x131b2e), alpha: 1 });
    world.addChild(bgRect);

    var sceneRoot = new PIXI.Container();
    var fxGraphics = new PIXI.Graphics();
    world.addChild(sceneRoot);
    world.addChild(fxGraphics);
    app.stage.addChild(world);

    var baseWorldPos = { x: 0, y: 0 };
    function resizeWorld() {
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      app.renderer.resize(vw, vh);
      var scale = SCALE_MODE === 'cover'
        ? Math.max(vw / stageW, vh / stageH)
        : Math.min(vw / stageW, vh / stageH);
      world.scale.set(scale, scale);
      baseWorldPos.x = (vw - stageW * scale) / 2;
      baseWorldPos.y = (vh - stageH * scale) / 2;
      world.position.set(baseWorldPos.x, baseWorldPos.y);
    }
    window.addEventListener('resize', resizeWorld);
    resizeWorld();

    var nodeMap = new Map();
    var objMap = new Map();
    var animatedSprites = [];
    var hasCollectibles = (scene.mechanics || []).length > 0;
    var bodies = new Map();

    function sliceSubTexture(baseTex, col, row, cols, rows) {
      var sc = Math.max(1, cols || 1);
      var sr = Math.max(1, rows || 1);
      var fw = Math.max(1, Math.floor(baseTex.width / sc));
      var fh = Math.max(1, Math.floor(baseTex.height / sr));
      var sx = Math.min(Math.max(0, col * fw), Math.max(0, baseTex.width - 1));
      var sy = Math.min(Math.max(0, row * fh), Math.max(0, baseTex.height - 1));
      return new PIXI.Texture({
        source: baseTex.source,
        frame: new PIXI.Rectangle(sx, sy, Math.min(fw, baseTex.width - sx), Math.min(fh, baseTex.height - sy))
      });
    }

    scene.objects.forEach(function (obj) {
      objMap.set(obj.id, obj);
      bodies.set(obj.id, {
        vx: 0,
        vy: 0,
        grounded: false,
        originX: obj.transform.x,
        originY: obj.transform.y,
        patrolPhase: 0
      });

      if (obj.components && obj.components.some(function (c) { return c.enabled && c.type === 'collectible'; })) {
        hasCollectibles = true;
      }

      var node;
      var w = obj.transform.width;
      var h = obj.transform.height;
      var ax = obj.transform.anchorX;
      var ay = obj.transform.anchorY;

      if (obj.type === 'sprite') {
        var baseTex = obj.sprite && obj.sprite.assetId ? textures.get(obj.sprite.assetId) : null;
        if (baseTex) {
          var anim = obj.sprite.animation;
          if (anim && anim.enabled) {
            var cols = Math.max(1, anim.cols || 1);
            var rows = Math.max(1, anim.rows || 1);
            var total = Math.max(1, Math.min(anim.frameCount || cols * rows, cols * rows));
            var frames = [];
            for (var f = 0; f < total; f++) {
              frames.push(sliceSubTexture(baseTex, f % cols, Math.floor(f / cols), cols, rows));
            }
            var animSprite = new PIXI.AnimatedSprite(frames);
            animSprite.anchor.set(ax, ay);
            animSprite.width = Math.max(1, w);
            animSprite.height = Math.max(1, h);
            animSprite.tint = parseColor(obj.sprite.tint, 0xffffff);
            animSprite.animationSpeed = Math.max(0.01, (anim.fps || 8) / 60);
            animSprite.loop = anim.loop !== false;
            if (anim.playing !== false) animSprite.play();
            animatedSprites.push(animSprite);
            node = animSprite;
          } else {
            var spr = new PIXI.Sprite(baseTex);
            spr.anchor.set(ax, ay);
            spr.width = Math.max(1, w);
            spr.height = Math.max(1, h);
            spr.tint = parseColor(obj.sprite.tint, 0xffffff);
            node = spr;
          }
        } else {
          node = new PIXI.Container();
        }
      } else if (obj.type === 'rectangle') {
        var rg = new PIXI.Graphics();
        var r = obj.rectangle || {};
        var left = -w * ax;
        var top = -h * ay;
        if ((r.cornerRadius || 0) > 0) {
          rg.roundRect(left, top, w, h, Math.min(r.cornerRadius, w / 2, h / 2));
        } else {
          rg.rect(left, top, w, h);
        }
        rg.fill({ color: parseColor(r.fillColor, 0x3b82f6), alpha: 1 });
        if ((r.strokeWidth || 0) > 0) {
          rg.stroke({ width: r.strokeWidth, color: parseColor(r.strokeColor, 0x93c5fd) });
        }
        node = rg;
      } else if (obj.type === 'circle') {
        var cg = new PIXI.Graphics();
        var c = obj.circle || {};
        cg.ellipse((0.5 - ax) * w, (0.5 - ay) * h, Math.max(1, w / 2), Math.max(1, h / 2));
        cg.fill({ color: parseColor(c.fillColor, 0x10b981), alpha: 1 });
        if ((c.strokeWidth || 0) > 0) {
          cg.stroke({ width: c.strokeWidth, color: parseColor(c.strokeColor, 0x6ee7b7) });
        }
        node = cg;
      } else if (obj.type === 'text') {
        var t = obj.text || {};
        var pText = new PIXI.Text({
          text: t.text || '',
          style: new PIXI.TextStyle({
            fontFamily: t.fontFamily || 'sans-serif',
            fontSize: Math.max(8, t.fontSize || 28),
            fontWeight: t.fontWeight === 'bold' ? '700' : '400',
            fill: parseColor(t.color, 0xffffff),
            align: t.align || 'center'
          })
        });
        pText.anchor.set(ax, ay);
        node = pText;
      } else if (obj.type === 'tilemap') {
        var tc = new PIXI.Container();
        var tm = obj.tilemap;
        if (tm) {
          var ox = -tm.cols * tm.tileWidth * ax;
          var oy = -tm.rows * tm.tileHeight * ay;
          var tsTex = tm.assetId ? textures.get(tm.assetId) : null;
          var tileCache = new Map();
          var fallbackColors = [0x3b82f6, 0x10b981, 0xf59e0b, 0x64748b, 0xec4899, 0x8b5cf6];
          var fbG = new PIXI.Graphics();
          Object.keys(tm.cells || {}).forEach(function (key) {
            var parts = key.split(',');
            var col = Number(parts[0]);
            var row = Number(parts[1]);
            var tileIdx = tm.cells[key];
            var px = ox + col * tm.tileWidth;
            var py = oy + row * tm.tileHeight;
            if (tsTex) {
              var cached = tileCache.get(tileIdx);
              if (!cached) {
                var tsC = Math.max(1, tm.tilesetCols || 1);
                var tsR = Math.max(1, tm.tilesetRows || 1);
                cached = sliceSubTexture(tsTex, tileIdx % tsC, Math.floor(tileIdx / tsC) % tsR, tsC, tsR);
                tileCache.set(tileIdx, cached);
              }
              var ts = new PIXI.Sprite(cached);
              ts.position.set(px, py);
              ts.width = tm.tileWidth;
              ts.height = tm.tileHeight;
              tc.addChild(ts);
            } else {
              fbG.rect(px, py, tm.tileWidth, tm.tileHeight);
              fbG.fill({ color: fallbackColors[Math.abs(tileIdx) % fallbackColors.length], alpha: 0.9 });
            }
          });
          tc.addChild(fbG);
        }
        node = tc;
      } else {
        node = new PIXI.Container();
      }

      node.position.set(obj.transform.x, obj.transform.y);
      node.rotation = obj.transform.rotation * DEG_TO_RAD;
      node.scale.set(
        obj.transform.scaleX * (obj.sprite && obj.sprite.flipX ? -1 : 1),
        obj.transform.scaleY * (obj.sprite && obj.sprite.flipY ? -1 : 1)
      );
      node.alpha = obj.opacity;
      node.visible = obj.visible;
      nodeMap.set(obj.id, node);
    });

    scene.objects.forEach(function (obj) {
      var node = nodeMap.get(obj.id);
      if (!node) return;
      if (obj.parentId && nodeMap.has(obj.parentId)) {
        nodeMap.get(obj.parentId).addChild(node);
      } else {
        sceneRoot.addChild(node);
      }
    });

    var variables = new Map();
    (gameData.variables || []).forEach(function (v) {
      variables.set(v.name, v.initialValue);
    });
    if (!variables.has('puntos')) variables.set('puntos', 0);

    var scoreBox = document.getElementById('nx-score-box');
    var scoreSpan = document.getElementById('nx-score');
    if (hasCollectibles && scoreBox) {
      scoreBox.classList.remove('hidden');
    }
    if (scoreSpan) {
      scoreSpan.textContent = String(variables.get('puntos') || 0);
    }

    var input = { left: false, right: false, up: false, down: false, jump: false };
    var prevInput = { left: false, right: false, up: false, down: false, jump: false };
    window.addEventListener('keydown', function (e) {
      ensureAudio();
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.left = true;
      if (e.code === 'ArrowRight' || e.code === 'KeyD') input.right = true;
      if (e.code === 'ArrowUp' || e.code === 'KeyW') input.up = true;
      if (e.code === 'ArrowDown' || e.code === 'KeyS') input.down = true;
      if (e.code === 'Space') input.jump = true;
    });
    window.addEventListener('keyup', function (e) {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.left = false;
      if (e.code === 'ArrowRight' || e.code === 'KeyD') input.right = false;
      if (e.code === 'ArrowUp' || e.code === 'KeyW') input.up = false;
      if (e.code === 'ArrowDown' || e.code === 'KeyS') input.down = false;
      if (e.code === 'Space') input.jump = false;
    });

    document.querySelectorAll('[data-key]').forEach(function (btn) {
      var k = btn.getAttribute('data-key');
      btn.addEventListener('pointerdown', function () { ensureAudio(); input[k] = true; });
      btn.addEventListener('pointerup', function () { input[k] = false; });
      btn.addEventListener('pointercancel', function () { input[k] = false; });
      btn.addEventListener('pointerleave', function () { input[k] = false; });
    });

    var paused = false;
    var pauseOverlay = document.getElementById('nx-pause-overlay');
    var pauseBtn = document.getElementById('nx-pause-btn');
    var resumeBtn = document.getElementById('nx-resume-btn');
    var fsBtn = document.getElementById('nx-fs-btn');

    function setPaused(next) {
      paused = next;
      if (pauseOverlay) pauseOverlay.classList.toggle('hidden', !paused);
      if (window.NexusPortal) {
        if (paused) window.NexusPortal.gameplayStop();
        else window.NexusPortal.gameplayStart();
      }
      animatedSprites.forEach(function (s) {
        if (paused) s.stop(); else s.play();
      });
    }

    if (pauseBtn) pauseBtn.addEventListener('click', function () { setPaused(!paused); });
    if (resumeBtn) resumeBtn.addEventListener('click', function () { setPaused(false); });
    if (fsBtn) {
      fsBtn.addEventListener('click', function () {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(function () {});
        } else {
          document.exitFullscreen().catch(function () {});
        }
      });
    }

    function getAABB(obj) {
      var w = Math.abs(obj.transform.width * obj.transform.scaleX);
      var h = Math.abs(obj.transform.height * obj.transform.scaleY);
      var left = obj.transform.x - w * obj.transform.anchorX;
      var top = obj.transform.y - h * obj.transform.anchorY;
      return { left: left, right: left + w, top: top, bottom: top + h };
    }
    function overlaps(a, b) {
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    }

    function getSolids() {
      var boxes = [];
      scene.objects.forEach(function (obj) {
        if (!obj.visible || !obj.components) return;
        var hasSolid = obj.components.some(function (c) { return c.enabled && c.type === 'solid'; });
        if (!hasSolid) return;
        if (obj.type === 'tilemap' && obj.tilemap) {
          var tm = obj.tilemap;
          var tw = tm.tileWidth * obj.transform.scaleX;
          var th = tm.tileHeight * obj.transform.scaleY;
          var ox = obj.transform.x - tm.cols * tw * obj.transform.anchorX;
          var oy = obj.transform.y - tm.rows * th * obj.transform.anchorY;
          Object.keys(tm.cells || {}).forEach(function (key) {
            var p = key.split(',');
            var l = ox + Number(p[0]) * tw;
            var t = oy + Number(p[1]) * th;
            boxes.push({ left: l, right: l + tw, top: t, bottom: t + th });
          });
        } else {
          boxes.push(getAABB(obj));
        }
      });
      return boxes;
    }

    var particles = [];
    var shakeRemaining = 0;
    var shakeIntensity = 0;
    var sceneStarted = false;
    var activeCollisions = new Set();
    var timerAcc = new Map();

    if (window.NexusPortal) {
      window.NexusPortal.loadingFinished();
      window.NexusPortal.gameplayStart();
    }

    app.ticker.add(function (ticker) {
      if (paused) return;
      var dt = Math.min(ticker.deltaMS / 1000, 0.05);
      var solids = getSolids();
      var players = [];

      scene.objects.forEach(function (obj) {
        if (!obj.visible || !obj.components) return;
        if (obj.components.some(function (c) { return c.enabled && (c.type === 'player_platformer' || c.type === 'player_topdown'); })) {
          players.push(obj);
        }
      });

      scene.objects.forEach(function (obj) {
        if (!obj.visible) return;
        var body = bodies.get(obj.id);
        var comps = obj.components || [];

        comps.forEach(function (c) {
          if (!c.enabled) return;
          if (c.type === 'spin') {
            obj.transform.rotation = (obj.transform.rotation + Number(c.config.degPerSec || 90) * dt) % 360;
          }
          if (c.type === 'patrol') {
            var dist = Number(c.config.distance || 120);
            var spd = Number(c.config.speed || 90);
            body.patrolPhase += (dist > 0 ? spd / dist : 0) * dt;
            var off = Math.sin(body.patrolPhase) * dist;
            var px0 = obj.transform.x;
            var py0 = obj.transform.y;
            if (c.config.axis === 'y') {
              obj.transform.y = body.originY + off;
              body.vy = dt > 0 ? (obj.transform.y - py0) / dt : 0;
            } else {
              obj.transform.x = body.originX + off;
              body.vx = dt > 0 ? (obj.transform.x - px0) / dt : 0;
            }
          }
          if (c.type === 'chase_player' && players.length > 0) {
            var tgt = players[0];
            var dxP = tgt.transform.x - obj.transform.x;
            var dyP = tgt.transform.y - obj.transform.y;
            var distP = Math.hypot(dxP, dyP);
            var rad = Number(c.config.detectRadius || 420);
            var stopD = Number(c.config.stopDistance || 36);
            var cSpd = Number(c.config.speed || 130);
            if (distP <= rad && distP > stopD && distP > 0.001) {
              body.vx = (dxP / distP) * cSpd;
              body.vy = (dyP / distP) * cSpd;
              obj.transform.x += body.vx * dt;
              obj.transform.y += body.vy * dt;
              if (obj.sprite) obj.sprite.flipX = dxP < 0;
            } else {
              body.vx = 0;
              body.vy = 0;
            }
          }
        });

        var plat = comps.find(function (c) { return c.enabled && c.type === 'player_platformer'; });
        var td = comps.find(function (c) { return c.enabled && c.type === 'player_topdown'; });

        if (plat) {
          var speed = Number(plat.config.speed || 260);
          var jumpForce = Number(plat.config.jumpForce || 520);
          var gravity = Number(plat.config.gravity || 1300);
          var mx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
          body.vx = mx * speed;
          if (mx < 0 && obj.sprite) obj.sprite.flipX = true;
          if (mx > 0 && obj.sprite) obj.sprite.flipX = false;
          if ((input.jump || input.up) && body.grounded) {
            body.vy = -jumpForce;
            body.grounded = false;
          }
          body.vy += gravity * dt;

          obj.transform.x += body.vx * dt;
          var box = getAABB(obj);
          solids.forEach(function (s) {
            if (overlaps(box, s)) {
              if (body.vx > 0) obj.transform.x -= box.right - s.left;
              else if (body.vx < 0) obj.transform.x += s.right - box.left;
              body.vx = 0;
              box = getAABB(obj);
            }
          });

          obj.transform.y += body.vy * dt;
          body.grounded = false;
          box = getAABB(obj);
          solids.forEach(function (s) {
            if (overlaps(box, s)) {
              if (body.vy > 0) {
                obj.transform.y -= box.bottom - s.top;
                body.vy = 0;
                body.grounded = true;
              } else if (body.vy < 0) {
                obj.transform.y += s.bottom - box.top;
                body.vy = 0;
              }
              box = getAABB(obj);
            }
          });
        } else if (td) {
          var tSpeed = Number(td.config.speed || 240);
          var dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
          var dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
          if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }
          body.vx = dx * tSpeed;
          body.vy = dy * tSpeed;
          if (dx < 0 && obj.sprite) obj.sprite.flipX = true;
          if (dx > 0 && obj.sprite) obj.sprite.flipX = false;
          obj.transform.x += body.vx * dt;
          var b2 = getAABB(obj);
          solids.forEach(function (s) {
            if (overlaps(b2, s)) {
              if (dx > 0) obj.transform.x -= b2.right - s.left;
              else if (dx < 0) obj.transform.x += s.right - b2.left;
              body.vx = 0;
              b2 = getAABB(obj);
            }
          });
          obj.transform.y += body.vy * dt;
          b2 = getAABB(obj);
          solids.forEach(function (s) {
            if (overlaps(b2, s)) {
              if (dy > 0) obj.transform.y -= b2.bottom - s.top;
              else if (dy < 0) obj.transform.y += s.bottom - b2.top;
              body.vy = 0;
              b2 = getAABB(obj);
            }
          });
        }

        var node = nodeMap.get(obj.id);
        if (node) {
          if (obj.sprite && obj.sprite.animation && obj.sprite.animation.enabled && obj.sprite.animation.linkToMovement && typeof node.gotoAndStop === 'function') {
            var isMoving = Math.abs(body.vx) > 5 || (!plat && Math.abs(body.vy) > 5);
            if (isMoving && !node.playing) node.play();
            else if (!isMoving && node.playing) node.gotoAndStop(0);
          }
          node.position.set(obj.transform.x, obj.transform.y);
          node.rotation = obj.transform.rotation * DEG_TO_RAD;
          node.scale.set(
            obj.transform.scaleX * (obj.sprite && obj.sprite.flipX ? -1 : 1),
            obj.transform.scaleY * (obj.sprite && obj.sprite.flipY ? -1 : 1)
          );
          node.visible = obj.visible;
        }
      });

      // Evaluar reglas estructuradas (GameMechanic[])
      var mechanics = (scene.mechanics || []).filter(function (m) { return m.enabled; });
      mechanics.sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); });
      var collisionHandled = new Set();
      mechanics.forEach(function (m) {
        if (m.trigger && m.trigger.event === 'collision.enter' && m.trigger.target) {
          collisionHandled.add(m.trigger.target);
        }
      });

      var nextCollisions = new Set();
      mechanics.forEach(function (mech) {
        var ev = mech.trigger ? mech.trigger.event : '';
        var trig = false;
        if (ev === 'scene.start' && !sceneStarted) trig = true;
        else if (ev === 'tick') trig = true;
        else if (ev === 'input.pressed') {
          var k = mech.trigger.key || 'Space';
          var down = k === 'Space' ? input.jump : k === 'ArrowLeft' || k === 'KeyA' ? input.left : k === 'ArrowRight' || k === 'KeyD' ? input.right : k === 'ArrowUp' || k === 'KeyW' ? input.up : input.down;
          var was = k === 'Space' ? prevInput.jump : k === 'ArrowLeft' || k === 'KeyA' ? prevInput.left : k === 'ArrowRight' || k === 'KeyD' ? prevInput.right : k === 'ArrowUp' || k === 'KeyW' ? prevInput.up : prevInput.down;
          if (down && !was) trig = true;
        } else if (ev === 'timer.elapsed') {
          var iv = Math.max(0.05, Number(mech.trigger.intervalSec || 1));
          var acc = (timerAcc.get(mech.id) || 0) + dt;
          if (acc >= iv) { timerAcc.set(mech.id, acc - iv); trig = true; }
          else timerAcc.set(mech.id, acc);
        } else if (ev === 'collision.enter') {
          var tObj = objMap.get(mech.trigger.target);
          var srcs = mech.trigger.sourceObjectId ? [objMap.get(mech.trigger.sourceObjectId)].filter(Boolean) : players;
          if (tObj && tObj.visible && srcs.length > 0) {
            var tb = getAABB(tObj);
            srcs.forEach(function (sObj) {
              if (!sObj.visible) return;
              var pk = mech.id + ':' + sObj.id + ':' + tObj.id;
              if (overlaps(getAABB(sObj), tb)) {
                nextCollisions.add(pk);
                if (!activeCollisions.has(pk)) trig = true;
              }
            });
          }
        }
        if (!trig) return;

        var condOk = (mech.conditions || []).every(function (cond) {
          if (cond.type === 'object.visible') {
            var o = objMap.get(cond.target);
            return o && o.visible === (cond.value === undefined ? true : Boolean(cond.value));
          }
          if (cond.type === 'object.grounded') {
            var bd = bodies.get(cond.target);
            return bd && bd.grounded === (cond.value === undefined ? true : Boolean(cond.value));
          }
          if (cond.type === 'variable.compare') {
            var lv = Number(variables.get(cond.variable) || 0);
            var rv = Number(cond.value || 0);
            if (cond.operator === '>') return lv > rv;
            if (cond.operator === '>=') return lv >= rv;
            if (cond.operator === '<') return lv < rv;
            if (cond.operator === '<=') return lv <= rv;
            if (cond.operator === '!=') return lv !== rv;
            return lv === rv;
          }
          return true;
        });
        if (!condOk) return;

        (mech.actions || []).forEach(function (act) {
          var p = act.parameters || {};
          if (act.type === 'variable.add') {
            var vn = String(p.variable || 'puntos');
            var nv = (Number(variables.get(vn) || 0) || 0) + (Number(p.amount || 1) || 0);
            variables.set(vn, nv);
            if ((vn === 'puntos' || vn === 'score') && scoreSpan) scoreSpan.textContent = String(nv);
          } else if (act.type === 'variable.set') {
            var vs = String(p.variable || 'puntos');
            variables.set(vs, p.value);
            if ((vs === 'puntos' || vs === 'score') && scoreSpan) scoreSpan.textContent = String(p.value);
          } else if (act.type === 'audio.beep') {
            playSynth(p.preset || 'coin', getChannelGain(p.channel || 'sfx'));
          } else if (act.type === 'audio.play') {
            playAudioAsset(p.assetId || p.asset, getChannelGain(p.channel || 'sfx'));
          } else if (act.type === 'object.destroy' || act.type === 'object.hide') {
            var to = objMap.get(p.target);
            if (to) { to.visible = false; var tn = nodeMap.get(to.id); if (tn) tn.visible = false; }
          } else if (act.type === 'object.show') {
            var ts = objMap.get(p.target);
            if (ts) { ts.visible = true; var tsn = nodeMap.get(ts.id); if (tsn) tsn.visible = true; }
          } else if (act.type === 'camera.shake') {
            shakeIntensity = Math.max(shakeIntensity, Number(p.intensity || 8));
            shakeRemaining = Math.max(shakeRemaining, Number(p.duration || 0.25));
          } else if (act.type === 'particles.burst') {
            var ptObj = objMap.get(p.target);
            particles.push({
              x: ptObj ? ptObj.transform.x : stageW / 2,
              y: ptObj ? ptObj.transform.y : stageH / 2,
              color: parseColor(p.color, 0x34d399),
              count: Math.min(24, Number(p.count || 12)),
              age: 0,
              duration: 0.45
            });
          }
        });
      });
      sceneStarted = true;
      activeCollisions = nextCollisions;
      prevInput = Object.assign({}, input);

      if (players.length > 0) {
        var pBoxes = players.map(getAABB);
        scene.objects.forEach(function (obj) {
          if (!obj.visible || !obj.components || collisionHandled.has(obj.id)) return;
          var col = obj.components.find(function (c) { return c.enabled && c.type === 'collectible'; });
          if (!col) return;
          var cb = getAABB(obj);
          if (pBoxes.some(function (pb) { return overlaps(pb, cb); })) {
            obj.visible = false;
            var n = nodeMap.get(obj.id);
            if (n) n.visible = false;
            var nextPts = (Number(variables.get('puntos') || 0) || 0) + Number(col.config.points || 10);
            variables.set('puntos', nextPts);
            if (scoreSpan) scoreSpan.textContent = String(nextPts);
            playSynth('coin', getChannelGain('sfx'));
            particles.push({ x: obj.transform.x, y: obj.transform.y, color: 0x34d399, count: 10, age: 0, duration: 0.4 });
          }
        });
      }

      // Actualizar partículas y sacudida de cámara
      fxGraphics.clear();
      particles = particles.filter(function (pt) {
        pt.age += dt;
        if (pt.age >= pt.duration) return false;
        var t = pt.age / pt.duration;
        var alpha = 1 - t;
        for (var k = 0; k < pt.count; k++) {
          var ang = (Math.PI * 2 * k) / pt.count;
          var spd = 55 + (k % 3) * 35;
          fxGraphics.circle(pt.x + Math.cos(ang) * spd * pt.age, pt.y + Math.sin(ang) * spd * pt.age - 18 * pt.age, Math.max(1.5, 4 * (1 - t * 0.7)));
          fxGraphics.fill({ color: pt.color, alpha: alpha });
        }
        return true;
      });

      if (shakeRemaining > 0) {
        shakeRemaining = Math.max(0, shakeRemaining - dt);
        world.position.set(baseWorldPos.x + (Math.random() - 0.5) * shakeIntensity * 2, baseWorldPos.y + (Math.random() - 0.5) * shakeIntensity * 2);
      } else {
        world.position.set(baseWorldPos.x, baseWorldPos.y);
      }
    });
  }

  boot().catch(function (err) {
    console.error('[NEXUS HTML5 Runtime Error]', err);
  });
})();
