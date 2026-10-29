import type { NextConfig } from "next";

/**
 * 构建并发。
 *
 * 默认 1，不是随口定的：线上那台云服务器只有 1.6G 内存，`cpus: 2` 时 Next 的
 * 多进程构建会把内存顶穿。这个值曾经只在服务器上手工改过（本地仓库还写着 2），
 * 属于「热修没回仓」—— 下一次部署就会把服务器改回来，然后构建失败。
 * 所以改成可配置，默认值取服务器能扛的那个，本机想快就设 NEXT_BUILD_CPUS=4。
 */
const nextConfig: NextConfig = {
  experimental: {
    cpus: Number(process.env.NEXT_BUILD_CPUS ?? 1),
  },
};

export default nextConfig;
