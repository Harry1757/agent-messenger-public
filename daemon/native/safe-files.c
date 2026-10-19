#define _DARWIN_C_SOURCE
#define _GNU_SOURCE
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <stdint.h>
#include <sys/file.h>

// Fixed read-only helper. Each component is resolved relative to a held directory
// descriptor; no path-based reopen after validation and no symlink following.
static int safe_open(const char *p) {
 if (!p || p[0]!='/') return -1;
 char *copy=strdup(p); if(!copy) return -1;
 int fd=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC), next=-1;
 char *save=NULL, *part=strtok_r(copy,"/",&save);
 while(part && fd>=0) {
  if(!strcmp(part,".") || !strcmp(part,"..")) {close(fd);fd=-1;break;}
  char *following=strtok_r(NULL,"/",&save);
  next=openat(fd,part,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK|(following ? O_DIRECTORY : 0));
  close(fd); fd=next; part=following;
 }
 free(copy); return fd;
}
static int same(const struct stat *a,const struct stat *b) {
#if defined(__APPLE__)
 return a->st_dev==b->st_dev && a->st_ino==b->st_ino && a->st_size==b->st_size && b->st_nlink==1 &&
 a->st_mtimespec.tv_sec==b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec==b->st_mtimespec.tv_nsec &&
 a->st_ctimespec.tv_sec==b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec==b->st_ctimespec.tv_nsec;
#else
 return a->st_dev==b->st_dev && a->st_ino==b->st_ino && a->st_size==b->st_size && b->st_nlink==1 &&
 a->st_mtim.tv_sec==b->st_mtim.tv_sec && a->st_mtim.tv_nsec==b->st_mtim.tv_nsec &&
 a->st_ctim.tv_sec==b->st_ctim.tv_sec && a->st_ctim.tv_nsec==b->st_ctim.tv_nsec;
#endif
}
static int exact_read(int fd,unsigned char *buffer,size_t length) {
 size_t total=0;ssize_t n;
 while(total<length && (n=read(fd,buffer+total,length-total))>0) total+=(size_t)n;
 return total==length;
}
static int exact_write(int fd,const unsigned char *buffer,size_t length) {
 size_t total=0;ssize_t n;
 while(total<length && (n=write(fd,buffer+total,length-total))>0) total+=(size_t)n;
 return total==length;
}
static int mutate(const char *target,const char *operation,const char *backup) {
 unsigned char header[8];if(!exact_read(STDIN_FILENO,header,8)) return 3;
 uint32_t beforeSize=0,afterSize=0;
 for(int i=0;i<4;i++){beforeSize|=((uint32_t)header[i])<<(8*i);afterSize|=((uint32_t)header[4+i])<<(8*i);}
 if(beforeSize>262144 || afterSize>262144) return 3;
 unsigned char *expected=malloc(beforeSize+1),*content=malloc(afterSize+1),*current=malloc(262145);
 int parent=-1,fd=-1,backupParent=-1,backupFd=-1,status=3;
 char *targetCopy=strdup(target),*backupCopy=strdup(backup);
 if(!expected || !content || !current || !targetCopy || !backupCopy) goto done;
 if(!exact_read(STDIN_FILENO,expected,beforeSize) || !exact_read(STDIN_FILENO,content,afterSize)) goto done;
 char *leaf=strrchr(targetCopy,'/'),*backupLeaf=strrchr(backupCopy,'/');
 if(!leaf || !backupLeaf) goto done;
 *leaf++=0;*backupLeaf++=0;
 if(!*leaf || !*backupLeaf || !strcmp(leaf,"..") || !strcmp(backupLeaf,"..")) goto done;
 parent=safe_open(targetCopy);backupParent=safe_open(backupCopy);
 if(parent<0 || backupParent<0) goto done;
 fd=openat(parent,leaf,O_RDWR|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
 if(fd<0 || flock(fd,LOCK_EX|LOCK_NB)) goto done;
 struct stat before,after,entry;
 if(fstat(fd,&before) || !S_ISREG(before.st_mode) || before.st_nlink!=1 || before.st_size!=beforeSize ||
  !exact_read(fd,current,beforeSize) || memcmp(current,expected,beforeSize)) goto done;
 backupFd=openat(backupParent,backupLeaf,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
 if(backupFd<0 || !exact_write(backupFd,expected,beforeSize) || fsync(backupFd)) goto done;
 close(backupFd);backupFd=-1;
 if(lseek(fd,0,SEEK_SET)<0 || !exact_read(fd,current,beforeSize) || memcmp(current,expected,beforeSize) ||
  fstat(fd,&after) || !same(&before,&after) || fstatat(parent,leaf,&entry,AT_SYMLINK_NOFOLLOW) ||
  entry.st_dev!=before.st_dev || entry.st_ino!=before.st_ino || entry.st_nlink!=1) goto done;
 if(!strcmp(operation,"delete")) {
  if(unlinkat(parent,leaf,0)) goto done;
 } else {
  char temporary[256];
  if(snprintf(temporary,sizeof(temporary),".messenger-%s",backupLeaf)>=(int)sizeof(temporary)) goto done;
  int replacement=openat(parent,temporary,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,before.st_mode&0777);
  if(replacement<0) goto done;
  int ready=exact_write(replacement,content,afterSize) && !fsync(replacement);close(replacement);
  if(!ready || fstat(fd,&after) || !same(&before,&after) || fstatat(parent,leaf,&entry,AT_SYMLINK_NOFOLLOW) ||
    entry.st_dev!=before.st_dev || entry.st_ino!=before.st_ino || entry.st_nlink!=1 || renameat(parent,temporary,parent,leaf)) {
   unlinkat(parent,temporary,0);goto done;
  }
 }
 status=0;
 done:
 if(backupFd>=0)close(backupFd);if(fd>=0)close(fd);if(parent>=0)close(parent);if(backupParent>=0)close(backupParent);
 free(expected);free(content);free(current);free(targetCopy);free(backupCopy);return status;
}
int main(int argc,char **argv) {
 if((argc!=5 && argc!=6) || strlen(argv[1])>=PATH_MAX || argv[2][0]=='/' || strstr(argv[2],"\\")) return 2;
 char target[PATH_MAX];
 if(snprintf(target,sizeof(target),"%s%s%s",argv[1],argv[2][0]?"/":"",argv[2])>=(int)sizeof(target)) return 2;
 if(argc==6) {if(strcmp(argv[3],"write") && strcmp(argv[3],"delete"))return 2;return mutate(target,argv[3],argv[5]);}
 int fd=safe_open(target); if(fd<0) return 3;
 struct stat before,after; if(fstat(fd,&before)) {close(fd);return 3;}
 if(!strcmp(argv[3],"validate-directory")) {close(fd);return S_ISDIR(before.st_mode)?0:3;}
 if(!strcmp(argv[3],"validate-file")) {close(fd);return S_ISREG(before.st_mode)&&before.st_nlink==1?0:3;}
 if(!strcmp(argv[3],"list")) {
  if(!S_ISDIR(before.st_mode)) {close(fd);return 3;}
  DIR *dir=fdopendir(fd); if(!dir) {close(fd);return 3;}
  struct dirent *entry;int count=0;
  while((entry=readdir(dir))) {
   const char *name=entry->d_name;
   if(!strcmp(name,".") || !strcmp(name,"..") || strpbrk(name,"\n\r\t")) continue;
   struct stat child;
   if(fstatat(dirfd(dir),name,&child,AT_SYMLINK_NOFOLLOW) || (!S_ISDIR(child.st_mode) && !(S_ISREG(child.st_mode)&&child.st_nlink==1))) continue;
   printf("%c\t%s\n",S_ISDIR(child.st_mode)?'d':'f',name);
   if(++count>=201) break;
  }
  closedir(dir);return ferror(stdout)?4:0;
 }
 if(strcmp(argv[3],"read") || !S_ISREG(before.st_mode) || before.st_nlink!=1) {close(fd);return 3;}
 char *end=NULL; long limit=strtol(argv[4],&end,10);
 if(!end || *end || limit<1 || limit>262144 || before.st_size>limit) {close(fd);return 3;}
 unsigned char *buffer=malloc((size_t)limit+1);if(!buffer){close(fd);return 4;}
 ssize_t n;size_t total=0;
 while(total<(size_t)limit+1 && (n=read(fd,buffer+total,(size_t)limit+1-total))>0) total+=(size_t)n;
 int valid=n>=0 && total<=(size_t)limit && !fstat(fd,&after) && same(&before,&after);
 close(fd);if(!valid){free(buffer);return 3;}
 int ok=fwrite(buffer,1,total,stdout)==total;free(buffer);return ok?0:4;
}
