/* Independent LittleCMS oracle for the generated CMYK and Display P3 fixtures.
 * Build: cc scripts/color-reference.c $(pkg-config --cflags --libs lcms2) -o /tmp/pdfextract-color-reference
 * Run: /tmp/pdfextract-color-reference <CMYK profile> <Display P3 profile>
 */
#include <lcms2.h>
#include <stdio.h>
static void convert(const char *path, unsigned format, unsigned char *pixels) {
  cmsHPROFILE input=cmsOpenProfileFromFile(path,"r"),output=cmsCreate_sRGBProfile();
  cmsHTRANSFORM transform=cmsCreateTransform(input,format,output,TYPE_RGB_8,INTENT_PERCEPTUAL,0);
  unsigned char result[12];cmsDoTransform(transform,pixels,result,4);
  printf("[");for(int i=0;i<12;i++)printf("%s%u",i?",":"",result[i]);printf("]");
  cmsDeleteTransform(transform);cmsCloseProfile(input);cmsCloseProfile(output);
}
int main(int argc,char **argv) {
  if(argc!=3)return 1;
  unsigned char cmyk[]={0,255,255,0,255,0,255,0,255,255,0,0,0,0,0,255};
  unsigned char p3[]={128,64,32,32,128,64,64,32,128,180,180,40};
  printf("{\"oracle\":\"LittleCMS 2.19, perceptual, sRGB8\",\"cmyk\":");convert(argv[1],TYPE_CMYK_8,cmyk);
  printf(",\"displayP3\":");convert(argv[2],TYPE_RGB_8,p3);printf("}\n");return 0;
}
