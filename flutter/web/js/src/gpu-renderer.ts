// flutter/web/js/src/gpu-renderer.ts
// Phase 3: 100ms GPU LERP WebGL2 片元着色器离屏渐变渲染器

const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
}
`;

const FRAGMENT_SHADER_SOURCE = `
precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_frozen_texture;
uniform sampler2D u_new_iframe_tex;
uniform float u_progress;

void main() {
    vec4 oldColor = texture2D(u_frozen_texture, vec2(v_texCoord.x, 1.0 - v_texCoord.y));
    vec4 newColor = texture2D(u_new_iframe_tex, v_texCoord);
    gl_FragColor = mix(oldColor, newColor, clamp(u_progress, 0.0, 1.0));
}
`;

export class GpuConnectionRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  private isWebGLFallback: boolean = false;
  private isRoaming: boolean = false;
  private frozenTexture: WebGLTexture | null = null;
  private activeIFrameTexture: WebGLTexture | null = null;
  private program: WebGLProgram | null = null;

  private uFrozenTexLoc: WebGLUniformLocation | null = null;
  private uNewTexLoc: WebGLUniformLocation | null = null;
  private uProgressLoc: WebGLUniformLocation | null = null;

  private isAnimating: boolean = false;
  private animStartTime: number = 0;
  private readonly ANIM_DURATION_MS: number = 100; // 100ms LERP 硬件过渡

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.initializeRenderer();
  }

  /**
   * ⚙️ 初始化 WebGL 渲染管线与着色器程序
   */
  private initializeRenderer() {
    // WebGL 上下文丢失降轨哨兵
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.isWebGLFallback = true;
      console.warn("[GpuConnectionRenderer] WebGL Context lost. Gracefully falling back to 2D canvas.");
      this.destroyGpuResources(false);
    }, false);

    try {
      this.gl = (this.canvas.getContext('webgl2', {
        alpha: false,
        depth: false,
        antialias: false,
        preserveDrawingBuffer: true,
      }) || this.canvas.getContext('webgl', {
        alpha: false,
        depth: false,
        antialias: false,
        preserveDrawingBuffer: true,
      })) as WebGLRenderingContext;

      if (this.gl) {
        this.setupShaders();
        this.frozenTexture = this.createTexture();
        this.activeIFrameTexture = this.createTexture();
      } else {
        this.isWebGLFallback = true;
      }
    } catch (e) {
      console.error("[GpuConnectionRenderer] WebGL init error:", e);
      this.isWebGLFallback = true;
    }
  }

  private createTexture(): WebGLTexture | null {
    if (!this.gl) return null;
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  private setupShaders() {
    const gl = this.gl;
    if (!gl) return;

    const vertShader = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
    const fragShader = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);

    if (!vertShader || !fragShader) return;

    const prog = gl.createProgram();
    if (!prog) return;

    gl.attachShader(prog, vertShader);
    gl.attachShader(prog, fragShader);
    gl.linkProgram(prog);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("[GpuConnectionRenderer] Shader link error:", gl.getProgramInfoLog(prog));
      return;
    }

    this.program = prog;
    gl.useProgram(prog);

    // 获取 Uniform 位置
    this.uFrozenTexLoc = gl.getUniformLocation(prog, "u_frozen_texture");
    this.uNewTexLoc = gl.getUniformLocation(prog, "u_new_iframe_tex");
    this.uProgressLoc = gl.getUniformLocation(prog, "u_progress");

    // 绑定全屏矩形顶点位置
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1, -1,  1,
      -1,  1,  1, -1,  1,  1,
    ]), gl.STATIC_DRAW);

    const aPositionLoc = gl.getAttribLocation(prog, "a_position");
    gl.enableVertexAttribArray(aPositionLoc);
    gl.vertexAttribPointer(aPositionLoc, 2, gl.FLOAT, false, 0, 0);

    // 绑定纹理坐标
    const texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,  1, 0,  0, 1,
      0, 1,  1, 0,  1, 1,
    ]), gl.STATIC_DRAW);

    const aTexCoordLoc = gl.getAttribLocation(prog, "a_texCoord");
    gl.enableVertexAttribArray(aTexCoordLoc);
    gl.vertexAttribPointer(aTexCoordLoc, 2, gl.FLOAT, false, 0, 0);
  }

  private compileShader(type: number, source: string): WebGLShader | null {
    const gl = this.gl;
    if (!gl) return null;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("[GpuConnectionRenderer] Shader compile error:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  /**
   * 🚦 视口静态冻结 (Viewport Freeze)
   */
  public freezeViewport() {
    if (this.isWebGLFallback || !this.gl || !this.frozenTexture) return;
    this.isRoaming = true;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.frozenTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    console.log("[GpuConnectionRenderer] Viewport frozen into fbo texture.");
  }

  /**
   * 🎥 解码后帧绘制 (带 VideoFrame close Guard & Phase 3 100ms LERP)
   */
  public onFrameDecoded(videoFrame: any) {
    if (this.isWebGLFallback || !this.gl || !this.activeIFrameTexture) {
      this.renderCanvas2D(videoFrame);
      return;
    }

    const gl = this.gl;
    try {
      gl.bindTexture(gl.TEXTURE_2D, this.activeIFrameTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoFrame);

      if (this.isRoaming) {
        this.isRoaming = false;
        this.startLERPTransition();
      } else if (!this.isAnimating) {
        this.renderFrame(1.0); // 正常绘制新帧
      }
    } catch (e) {
      console.error("[GpuConnectionRenderer] Frame decode draw error:", e);
    } finally {
      if (videoFrame && typeof videoFrame.close === 'function') {
        videoFrame.close();
      }
    }
  }

  private renderCanvas2D(videoFrame: any) {
    const ctx = this.canvas.getContext('2d');
    if (ctx) {
      try {
        ctx.drawImage(videoFrame, 0, 0, this.canvas.width, this.canvas.height);
      } finally {
        if (videoFrame && typeof videoFrame.close === 'function') {
          videoFrame.close();
        }
      }
    }
  }

  /**
   * 💎 Phase 3: 启动 100ms 着色器 LERP 淡入平滑过度
   */
  public startLERPTransition() {
    if (this.isWebGLFallback || !this.gl || !this.program) return;
    console.log("[GpuConnectionRenderer] Phase 3: Starting 100ms GPU LERP Shader crossfade animation...");
    this.isAnimating = true;
    this.animStartTime = performance.now();
    this.animateLoop();
  }

  private animateLoop = () => {
    if (!this.isAnimating || !this.gl) return;
    const elapsed = performance.now() - this.animStartTime;
    const progress = Math.min(1.0, elapsed / this.ANIM_DURATION_MS);

    this.renderFrame(progress);

    if (progress < 1.0) {
      requestAnimationFrame(this.animateLoop);
    } else {
      this.isAnimating = false;
      console.log("[GpuConnectionRenderer] Phase 3: 100ms LERP crossfade transition completed successfully.");
    }
  };

  private renderFrame(progress: number) {
    const gl = this.gl;
    if (!gl || !this.program) return;

    gl.useProgram(this.program);

    // 绑定旧冻结帧纹理 (Unit 0)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frozenTexture);
    gl.uniform1i(this.uFrozenTexLoc, 0);

    // 绑定新帧纹理 (Unit 1)
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.activeIFrameTexture);
    gl.uniform1i(this.uNewTexLoc, 1);

    // 设置插值进度
    gl.uniform1f(this.uProgressLoc, progress);

    // 绘图
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * 🧹 会话注销 1x1 物理显存擦除 (Physical Memory Wipe)
   */
  public destroyGpuResources(closeSession: boolean = true) {
    const gl = this.gl;
    if (!gl) return;

    const blackPixel = new Uint8Array([0, 0, 0, 0]);

    if (this.frozenTexture) {
      gl.bindTexture(gl.TEXTURE_2D, this.frozenTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, blackPixel);
      if (closeSession) {
        gl.deleteTexture(this.frozenTexture);
        this.frozenTexture = null;
      }
    }

    if (this.activeIFrameTexture) {
      gl.bindTexture(gl.TEXTURE_2D, this.activeIFrameTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, blackPixel);
      if (closeSession) {
        gl.deleteTexture(this.activeIFrameTexture);
        this.activeIFrameTexture = null;
      }
    }

    if (closeSession && this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }

    this.isAnimating = false;
    console.log("[GpuConnectionRenderer] VRAM wiped and resources disposed.");
  }
}
