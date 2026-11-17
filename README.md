# Note Taker

note-taker is currently in the INITIAL MVP PLANNING PHASE (user generated). 

What I want it to become:

### It will be a simple, lightweight web app, which can be easily self hosted and assigned to a port
  - Docker 

### It will be built in a sensible, modern framework, using the proper standard structures and packages.
  - I personally like nodejs/react/tailwind/tanstack/zod/psql+drizzle, but open to other options if they are more ideal.

### It will have full CI suite
  - lint+typings+unit tests with coverage bare minimum.

### It will have very basic authentication, username+password.
  - I'm interested in including passkey as alternative to password authentication *not needed for mvp if more complex than a few lines of code
  
### It will manage markdown notes, auto saving them in a folder structure.
  - Backend stores saved notes efficiently & securely. 2 way encrypted?
  - Folders and notes persistence: Raw file system? or database?
  - Folders and filenames can be renamed.

### It will provide a text editor UI producing markdown. 
  - Text can be edited "word" style (edit formatted markdown directly with toolbar) 
  OR
  Text can be edited with raw markdown and format previewed.
