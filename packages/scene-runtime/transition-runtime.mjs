// @ts-nocheck -- This self-contained browser source is serialized; tested both as JS and via its DOM contract.
/**
 * Original, seek-safe transition rendering. The exact same function source is
 * served to Studio and offline stage capture. No animation or wall clock runs.
 */

/** Self-contained so the content origin can serialize this exact pure function. */
export function transitionFrame(spec, time, stage = { w: 1280, h: 720 }) {
  const n = Number(time), start = Number(spec.start), end = Number(spec.end);
  if (!Number.isFinite(n) || !(end > start) || n < start || n > end) return { active: false };
  const p = Math.max(0, Math.min(1, (n - start) / (end - start)));
  const q = 1 - p, effect = spec.effect, direction = spec.direction;
  const width = Number(stage.w) || 1280, height = Number(stage.h) || 720;
  const fmt = (x) => String(Math.round(x * 10000) / 10000);
  const from = { opacity: 1 }, to = { opacity: 1 };
  const result = { active: true, progress: p, from, to, audio: { from: q, to: p }, overlay: null };
  if (spec.mechanism === 'overlay') {
    result.overlay = { effect, progress: p, strength: Math.sin(Math.PI * p) };
    return result;
  }
  if (effect === 'fade-in') { to.opacity = p; return result; }
  if (effect === 'fade-out') { to.opacity = q; result.audio.to = q; return result; }
  if (effect === 'dissolve') { to.opacity = p; return result; }
  if (effect === 'push' || effect === 'slide') {
    const x = direction === 'left' ? -1 : direction === 'right' ? 1 : 0;
    const y = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    if (effect === 'push') {
      to.transform = `translate(${fmt(-x * q * width)}px,${fmt(-y * q * height)}px)`;
      from.transform = `translate(${fmt(x * p * width)}px,${fmt(y * p * height)}px)`;
    } else to.transform = `translate(${fmt(x * q * width)}px,${fmt(y * q * height)}px)`;
    return result;
  }
  if (effect === 'wipe') {
    const k = fmt(q * 100);
    to.clipPath = direction === 'left' ? `inset(0 0 0 ${k}%)`
      : direction === 'right' ? `inset(0 ${k}% 0 0)`
      : direction === 'up' ? `inset(${k}% 0 0 0)` : `inset(0 0 ${k}% 0)`;
  } else if (effect === 'soft-wipe') {
    const k = p * 130 - 15;
    to.maskImage = `linear-gradient(90deg,#000 ${fmt(k - 12)}%,transparent ${fmt(k + 12)}%)`;
  } else if (effect === 'iris') {
    to.clipPath = `circle(${fmt(p * 75)}% at 50% 50%)`;
  } else if (effect === 'diamond') {
    const r = p * 110;
    to.clipPath = `polygon(50% ${fmt(50-r)}%,${fmt(50+r)}% 50%,50% ${fmt(50+r)}%,${fmt(50-r)}% 50%)`;
  } else if (effect === 'split') {
    const k = fmt(q * 50);
    to.clipPath = direction === 'horizontal' ? `inset(${k}% 0)` : `inset(0 ${k}%)`;
  } else if (effect === 'zoom-in') {
    from.transform = `scale(${fmt(1 + 0.25 * p)})`;
    to.transform = `scale(${fmt(0.75 + 0.25 * p)})`; to.opacity = p;
  } else if (effect === 'zoom-out') {
    from.transform = `scale(${fmt(1 - 0.2 * p)})`;
    to.transform = `scale(${fmt(1.3 - 0.3 * p)})`; to.opacity = p;
  } else if (effect === 'spin') {
    const sign = direction === 'ccw' ? -1 : 1;
    from.transform = `rotate(${fmt(sign * p * 35)}deg) scale(${fmt(1 - p * 0.2)})`;
    to.transform = `rotate(${fmt(-sign * q * 35)}deg) scale(${fmt(0.8 + p * 0.2)})`; to.opacity = p;
  } else if (effect === 'blur') {
    from.filter = `blur(${fmt(p * 14)}px)`;
    to.filter = `blur(${fmt(q * 14)}px)`; to.opacity = p;
  }
  return result;
}

/** Self-contained browser factory. It is also used for the library's actual DOM preview. */
export function createTransitionRuntime(frameAt) {
  var previous = [], specifications = [], canvas = null;
  var attr = 'data-opencut-transition';
  function parse(clip) {
    try {
      var raw = clip.el && clip.el.getAttribute(attr);
      if (!raw || raw.length > 32768) return null;
      var s = JSON.parse(raw);
      return s.version === 1 && typeof s.effect === 'string' && s.end > s.start && typeof s.to === 'string' ? s : null;
    } catch (_) { return null; }
  }
  function restore() {
    for (var i = 0; i < previous.length; i++) {
      var record = previous[i];
      for (var key in record.values) {
        var v = record.values[key];
        if (v.value) record.el.style.setProperty(key, v.value, v.priority);
        else record.el.style.removeProperty(key);
      }
    }
    previous = [];
  }
  function beforeFrame(clips) {
    restore();
    specifications = [];
    for (var i = 0; i < clips.length; i++) {
      var s = parse(clips[i]);
      if (s && !clips[i].hidden && !clips[i].soloHidden) specifications.push(s);
    }
    if (canvas) {
      var ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
  function audioGain(clip, time) {
    if (clip.kind === 'sound') return 1; // Existing sound fade is already mixed once.
    for (var i = 0; i < specifications.length; i++) {
      var s = specifications[i];
      if (s.mechanism === 'overlay' || (s.from !== clip.id && s.to !== clip.id)) continue;
      var p = Math.max(0, Math.min(1, (time - s.start) / (s.end - s.start)));
      if (s.effect === 'fade-out') return s.to === clip.id ? 1 - p : 1;
      return s.from === clip.id ? 1 - p : p;
    }
    return 1;
  }
  function put(clip, properties) {
    if (!clip || !clip.el || !properties) return;
    var el = clip.el, values = {}, view = el.ownerDocument.defaultView;
    var css = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
    for (var k in properties) {
      var name = k === 'clipPath' ? 'clip-path' : k === 'maskImage' ? 'mask-image' : k;
      values[name] = { value: el.style.getPropertyValue(name), priority: el.style.getPropertyPriority(name) };
      var value = properties[k];
      if (k === 'opacity') {
        // The legacy fade has run already: use its captured *unfaded* opacity.
        var base = Number(clip.baseOpacity);
        if (clip.baseOpacity == null || !Number.isFinite(base)) base = css ? Number(css.opacity) : 1;
        value = String(Math.max(0, Math.min(1, base * Number(value))));
      } else if (k === 'transform' || k === 'filter') {
        var original = css ? css[k] : el.style[k];
        value = String(value) + (original && original !== 'none' ? ' ' + original : '');
        if (k === 'transform') {
          values['transform-origin'] = { value: el.style.getPropertyValue('transform-origin'), priority: el.style.getPropertyPriority('transform-origin') };
          el.style.setProperty('transform-origin', '50% 50%', 'important');
        }
      }
      el.style.setProperty(name, String(value), 'important');
    }
    previous.push({ el, values });
  }
  function overlay(document, stage, item) {
    if (!canvas || canvas.ownerDocument !== document) {
      canvas = document.createElement('canvas');
      canvas.setAttribute('data-opencut-transition-overlay', '');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2147480000';
      document.body.appendChild(canvas);
    }
    var w = Number(stage.w) || 1280, h = Number(stage.h) || 720;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    var c = canvas.getContext('2d');
    if (!c) return;
    var p = item.progress, s = Math.max(0, item.strength), e = item.effect;
    if (s < 0.00001) return;
    c.save();
    var seed = Math.floor(p * 120) + 1717;
    function rand() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
    function fill(color, alpha) { c.globalAlpha = alpha; c.fillStyle = color; c.fillRect(0, 0, w, h); }
    if (e === 'dip-black' || e === 'dip-white') fill(e === 'dip-black' ? '#000' : '#fff', s);
    else if (e === 'light-sweep') {
      var x = (p * 1.8 - 0.4) * w;
      var g = c.createLinearGradient(x-w*0.4, 0, x+w*0.4, h);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,245,210,.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      fill(g, s);
    } else if (e === 'flare' || e === 'film-burn') {
      var gx = e === 'flare' ? w*0.55 : w*(0.15+0.7*p), gy = e === 'flare' ? h*0.4 : h*0.85;
      var glow = c.createRadialGradient(gx, gy, 0, gx, gy, Math.max(w,h)*(e === 'flare' ? 0.8 : 1.15));
      glow.addColorStop(0, '#fffbd4'); glow.addColorStop(0.24, e === 'flare' ? '#ffda8a' : '#ff8d36'); glow.addColorStop(0.6, e === 'flare' ? 'rgba(255,150,70,.35)' : 'rgba(240,40,8,.7)'); glow.addColorStop(1, 'rgba(170,25,0,0)');
      fill(glow, s);
    } else if (e === 'shutter') {
      c.fillStyle = '#111'; c.fillRect(0,0,w,h*s/2); c.fillRect(0,h-h*s/2,w,h*s/2);
    } else if (e === 'blinds') {
      c.fillStyle = '#111'; for (var j=0;j<10;j++) c.fillRect(0,j*h/10,w,h*s/10+1);
    } else if (e === 'checker' || e === 'pixels') {
      var cell = w/16;
      for (var yy=0;yy<h;yy+=cell) for(var xx=0;xx<w;xx+=cell) {
        var col = Math.round(xx/cell), r = Math.round(yy/cell);
        var k = e === 'checker' ? Math.max(0,Math.min(1,s*1.5-((col+r)%2)*0.5)) : Math.max(0,Math.min(1,s*1.6-rand()*0.6));
        c.fillStyle = e === 'checker' ? '#eee8dc' : '#203a49'; c.fillRect(xx+(1-k)*cell/2,yy+(1-k)*cell/2,cell*k,cell*k);
      }
    } else if (e === 'stripes') {
      c.translate(w/2,h/2); c.rotate(-Math.PI/5); c.fillStyle='#ebe4d7';
      var size=Math.max(w,h)*2; for(var bar=-size;bar<size;bar+=size/12) c.fillRect(bar,-size,size*s/12+1,size*2);
    } else if (e === 'heart' || e === 'star') {
      c.translate(w/2,h/2); c.scale(s,s); c.fillStyle=e==='heart'?'#f26780':'#f7d16b'; c.beginPath();
      var radius=Math.max(w,h)*1.2;
      if(e==='star') for(var point=0;point<10;point++) {var angle=-Math.PI/2+point*Math.PI/5, rad=radius*(point%2?0.45:1);c.lineTo(Math.cos(angle)*rad,Math.sin(angle)*rad);}
      else {c.moveTo(0,radius*0.6);c.bezierCurveTo(-radius*1.3,-radius*0.1,-radius*0.6,-radius,0,-radius*0.35);c.bezierCurveTo(radius*0.6,-radius,radius*1.3,-radius*0.1,0,radius*0.6);}
      c.closePath();c.fill();
    } else if (e === 'glitch') {
      c.globalAlpha=s*0.8; for(var band=0;band<24;band++){c.fillStyle=['#33e7e0','#e3458f','#eee9d7'][band%3];c.fillRect(rand()*w*0.3,rand()*h,w*(0.2+rand()*0.8),2+rand()*h*0.1);}
    } else if (e === 'noise') {
      c.globalAlpha=s*0.85;var grain=12;for(var y=0;y<h;y+=grain)for(var x2=0;x2<w;x2+=grain){var v=Math.floor(rand()*255);c.fillStyle='rgb('+v+','+v+','+v+')';c.fillRect(x2,y,grain,grain);}
    } else if (e === 'confetti') {
      // Positions are seeded independently of p; seeking back produces the same particles.
      seed=1717; for(var part=0;part<130;part++){var px=rand()*w,py=rand()*h,phase=rand(),sz=5+rand()*15;c.globalAlpha=s;c.fillStyle=['#ef8e68','#75c7b5','#e6c76e','#9b9bd5'][part%4];c.save();c.translate(px+Math.sin((p+phase)*9)*35,py+(p-0.5)*h*0.7);c.rotate((p+phase)*8);c.fillRect(-sz/2,-sz/4,sz,sz/2);c.restore();}
    } else if(e==='ink') {
      seed=1717;c.fillStyle='#15242a';for(var blob=0;blob<18;blob++){var bx=rand()*w,by=rand()*h;c.beginPath();c.arc(bx,by,Math.max(w,h)*(0.05+rand()*0.35)*s,0,Math.PI*2);c.fill();}
    }
    c.restore();
  }
  function apply(clips, time, stage, document) {
    for(var i=0;i<specifications.length;i++) {
      var spec=specifications[i], state=frameAt(spec,time,stage);
      if(!state.active) continue;
      var from=null,to=null;
      for(var k=0;k<clips.length;k++){if(clips[k].id===spec.from)from=clips[k];if(clips[k].id===spec.to)to=clips[k];}
      if(state.overlay) overlay(document,stage,state.overlay);
      else {
        put(from,state.from);put(to,state.to);
        if(to&&from&&to.el&&from.el){var z=Math.max(Number(from.z)||0,Number(to.z)||0)+1;put(to,{'z-index':String(z)});}
      }
    }
  }
  function dispose() {restore();if(canvas)canvas.remove();canvas=null;specifications=[];}
  return { beforeFrame, apply, audioGain, dispose };
}

