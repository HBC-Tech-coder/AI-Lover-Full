/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // Hide the floating Next.js dev indicator (the round 'N' badge in
  // the corner). It only renders in dev mode; production builds never
  // showed it, but our deployment runs `node server.js` with
  // NODE_ENV != production, so it was on by default.
  devIndicators: false,
  webpack: (config) => {
    config.externals.push({
      "utf-8-validate": "commonjs utf-8-validate",
      bufferutil: "commonjs bufferutil",
    });
    return config;
  },
  // Live2D 模型 (moc3/PNG/json) 体积大且基本不会变,给一年 immutable 缓存,
  // 让二次访问直接命中浏览器缓存,跳过协商请求。改模型时换路径或加 query string busting。
  async headers() {
    return [
      {
        source: "/live2d/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/lib/live2dcubismcore.min.js",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
