declare module "cdt2d" {
 export default function cdt2d(points:number[][],edges?:number[][],options?:{delaunay?:boolean;interior?:boolean;exterior?:boolean;infinity?:boolean}):Array<[number,number,number]>;
}
