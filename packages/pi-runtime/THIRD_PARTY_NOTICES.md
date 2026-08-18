# Third-party notices

This file accompanies the TinyEdge edge-client workspace and each of its four
candidate npm packages. It records the reviewed third-party material in the
exact 0.1.3 / 0.84.2-tinyedge.1 dependency closure. It does not claim TinyEdge
authorship of that material and does not change any third-party license.

## Reviewed closure and legal-file coverage

- The Pi compatibility runtime lock contains 127 exact third-party dependency
  records: MIT (57), Apache-2.0 (44), BSD-3-Clause (13), ISC (7),
  BlueOak-1.0.0 (5), and 0BSD (1).
- The CLI lock adds the MIT-licensed @tinyedge/pi-runtime root, producing 128
  dependency records. Each accompanying SBOM.cdx.json records exact versions,
  registry URLs, SHA-512 integrity values, graph edges, vendored payloads, and
  native helper hashes.
- 116 of those 128 exact CLI dependency records retain a top-level legal file
  named LICENSE, LICENCE, COPYING, or NOTICE, including accepted suffix
  variants. Twelve exact records lack such a named file. One of the twelve,
  data-uri-to-buffer@4.0.1, carries its complete MIT notice in its shipped
  README; therefore eleven exact artifacts lack complete artifact legal text.
- @mariozechner/clipboard@0.3.9 and
  @silvia-odwyer/photon-node@0.3.4 are excluded optional peers and are not
  default install edges. The existing-Pi host is also an excluded peer of the
  add-on, not an installed dependency.

The 116 artifact-contained legal files remain authoritative for their
components and are not duplicated wholesale here. The sections below reproduce
the complete terms or notices needed for imported/vendored material and record
the exact evidence for every approved missing-named-file exception. Every
exception is limited to the recorded package name, version, registry URL, and
SRI bytes; it does not approve a future release.

Approved record dispositions:

- @aws-sdk/credential-provider-http@3.972.39 — accepted-exact-sri-artifact-declaration-only
- @aws-sdk/credential-provider-login@3.972.41 — accepted-exact-sri-artifact-declaration-only
- @aws-sdk/nested-clients@3.997.9 — accepted-exact-sri-artifact-declaration-only
- @earendil-works/pi-agent-core@0.84.2 — accepted-exact-sri-and-reviewed-source-license
- @earendil-works/pi-ai@0.84.2 — accepted-exact-sri-and-reviewed-source-license
- @earendil-works/pi-client@0.84.2 — accepted-exact-sri-and-reviewed-source-license
- @earendil-works/pi-protocol@0.84.2 — accepted-exact-sri-and-reviewed-source-license
- @earendil-works/pi-telemetry@0.84.2 — accepted-exact-sri-and-reviewed-source-license
- @earendil-works/pi-tui@0.84.2 — accepted-exact-sri-and-reviewed-source-license
- @nodable/entities@2.1.0 — accepted-exact-sri-and-githead-source-license
- data-uri-to-buffer@4.0.1 — accepted-exact-sri-artifact-readme-license
- xml-naming@0.1.0 — accepted-exact-sri-reproducible-byte-map-without-source-attestation

## Pi 0.84.2 payload, leaf packages, and native helpers

Reviewed source: https://github.com/earendil-works/pi

Reviewed commit: 914cf1472e715297caa30db4b9535d534a9eb718

Source-license SHA-256:
0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48

The following six exact leaf artifacts omit a named legal file and are covered
by the complete Mario Zechner MIT notice below:

| Exact artifact | Exact registry URL | Registry SHA-512 integrity |
| --- | --- | --- |
| @earendil-works/pi-agent-core@0.84.2 | https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.84.2.tgz | sha512-8Pn3wSCxj0cfo5I6jxQYVB/3uuQRmHhAlEclyjqpOuMEdQMIODHizRogv56FLdbU+dTiGnybeHQ2N+sV1/L2YA== |
| @earendil-works/pi-ai@0.84.2 | https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.84.2.tgz | sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig== |
| @earendil-works/pi-client@0.84.2 | https://registry.npmjs.org/@earendil-works/pi-client/-/pi-client-0.84.2.tgz | sha512-/RFSPhD/bZbpOp1oJj+UneSUFSgZhWxzcSENUY+8+8xhoBrWXMYI2t77XNx4Yf+c8YK2qTHquForhNcelYpXvg== |
| @earendil-works/pi-protocol@0.84.2 | https://registry.npmjs.org/@earendil-works/pi-protocol/-/pi-protocol-0.84.2.tgz | sha512-jbBh03fkeckWEroHpcZBr4w5/Ibat8WwdXFlXHivYQImrQNFtLpDeL0t1cku4hmK0q3pceIRQHkw4fwbM4YILQ== |
| @earendil-works/pi-telemetry@0.84.2 | https://registry.npmjs.org/@earendil-works/pi-telemetry/-/pi-telemetry-0.84.2.tgz | sha512-wg5caea7uIv1BHRBm2Y116RvFG4oSAiP5qk9tA2463PDGIr4K8M1Ceyyg5DOpF/shUUl0gk826yQJAeAcHYB9g== |
| @earendil-works/pi-tui@0.84.2 | https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.84.2.tgz | sha512-ds2TLihOnM5sLJB3VpXV6y0uR5efVuHf4MN7yDpsty6hA2DUO/EDVzjp/0od0G2JslzVLMjT8T8zavtxVb+qbg== |

The same notice covers the four reviewed Pi TUI native console helpers recorded
by exact path, platform, architecture, size, and SHA-256 in SBOM.cdx.json.

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## AWS SDK artifact-declaration-only exceptions

The following three exact registry artifacts declare Apache-2.0 in their
package.json but omit a named legal file. npm supplies no gitHead or exact
source commit for these artifacts, so the approved disposition is explicitly
artifact-declaration-only:

| Exact artifact | Exact registry URL | Registry SHA-512 integrity |
| --- | --- | --- |
| @aws-sdk/credential-provider-http@3.972.39 | https://registry.npmjs.org/@aws-sdk/credential-provider-http/-/credential-provider-http-3.972.39.tgz | sha512-pIgTpisWyWg7X1bUbzSjuUYosYTD0Ghz2M0hkSTmb3a6i3qV3uU+NYJPI/E2XSC0HcsZh5rsLPzeXrkb2DS0Cg== |
| @aws-sdk/credential-provider-login@3.972.41 | https://registry.npmjs.org/@aws-sdk/credential-provider-login/-/credential-provider-login-3.972.41.tgz | sha512-0LBitxXiAiaE5nlFPfpNIww/8FRY/I7WIndWsc9GmNFOM7cE1wNpVNQEGEk9Outg5l8xl+3vybxFyUy4l9q/LQ== |
| @aws-sdk/nested-clients@3.997.9 | https://registry.npmjs.org/@aws-sdk/nested-clients/-/nested-clients-3.997.9.tgz | sha512-jPR3rnmRI4hWYyzfmTGBr7NblMp8QYYeflHXba1H6+7CGrWVqWKQzaXFQ4qbExqPRsXN3T3L3JxFhr6aouXUGQ== |

Canonical Apache License, Version 2.0 text:


                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

## @nodable/entities@2.1.0

Exact registry URL:
https://registry.npmjs.org/@nodable/entities/-/entities-2.1.0.tgz

Registry integrity:
sha512-nyT7T3nbMyBI/lvr6L5TyWbFJAI9FTgVRakNoBqCD+PmID8DzFrrNdLLtHMwMszOtqZa8PAOV24ZqDnQrhQINA==

npm gitHead: f1c61a65e7b967c17b13822ef71e91bd25f17ce2

Reviewed source-license SHA-256:
750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40

MIT License

Copyright (c) 2026 Nodable

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## data-uri-to-buffer@4.0.1

This artifact has no separately named legal file, but its shipped README
contains the complete notice reproduced below. Exact registry URL:
https://registry.npmjs.org/data-uri-to-buffer/-/data-uri-to-buffer-4.0.1.tgz

Registry integrity:
sha512-0R9ikRb668HB7QDxT1vkpuUBtqc53YyAwMwGeUFKRojY/NWKvdZ+9UYtRfGmhqNbRkTSVpMbmyhXipFFv2cb/A==

npm gitHead: 85cd8c854aefbf1bb636789d80364cfac8ea1583

Shipped README SHA-256:
a7cc4332acfa1f9b6530e01aac77fefe74f2efa32579215fddaa473013f9a25c

(The MIT License)

Copyright (c) 2014 Nathan Rajlich &lt;nathan@tootallnate.net&gt;

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## xml-naming@0.1.0

Exact registry URL:
https://registry.npmjs.org/xml-naming/-/xml-naming-0.1.0.tgz

Registry integrity:
sha512-k8KO9hrMyNk6tUWqUfkTEZbezRRpONVOzUTnc97VnCvyj6Tf9lyUR9EDAIeiVLv56jsMcoXEwjW8Kv5yPY52lw==

Registry artifact SHA-256:
19347cbcba429e9f240427ce4e5998efe30a47cb9131b5673fc2f0441f7f4f57

Reviewed source-license SHA-256:
8e75fc0e776c62ccadb8178ece8d3daa9ba7601fb0a49b2dfb0ea9a7a5c0aa07

The four shipped files map byte-for-byte to candidate commit
c0afc395948730bed124859d7fc7cccabe0aac8a and reproduce with Node
22.14.0 plus npm 11.11.0. This is not a source attestation: npm supplies no
gitHead or attestation, there is no tag/release, and registry publication
preceded the unsigned candidate commit by about 2 hours 10 minutes. Approval
is limited to the exact registry URL and SRI above.

MIT License

Copyright (c) 2026 Natural Intelligence

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ignore@7.0.5 artifact-contained license evidence

ignore@7.0.5 is not an exception. Its exact registry artifact contains
LICENSE-MIT (1,095 bytes), SHA-256
9c94db23dc4b1e9aaee5d195668b916afc71efed54af226b66cf0ccc4389c1c0.
Exact registry URL: https://registry.npmjs.org/ignore/-/ignore-7.0.5.tgz

Registry integrity:
sha512-Hs59xBNfUIunMFgWAbGX5cq6893IbWg4KnrjbYwX3tx0ztorVgTDA6B2sxf8ejHJ4wz8BqGUMYlnzNBer5NvGg==

## Retained vendored JavaScript in @tinyedge/pi-runtime

### ansi-regex and strip-ansi portions

Retained file: `dist/utils/ansi.js`

Sources: <https://github.com/chalk/ansi-regex> and
<https://github.com/chalk/strip-ansi>

The following notice is also preserved inline in the retained file:

MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Highlight.js 11.9.0

Retained file: `dist/core/export-html/vendor/highlight.min.js`

Source: <https://github.com/highlightjs/highlight.js/tree/11.9.0>

BSD 3-Clause License

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### marked 18.0.5

Retained file: `dist/core/export-html/vendor/marked.min.js`

Source: <https://github.com/markedjs/marked/tree/v18.0.5>

#### Marked

Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

#### Markdown

Copyright © 2004, John Gruber
http://daringfireball.net/
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
* Neither the name “Markdown” nor the names of its contributors may be used to
  endorse or promote products derived from this software without specific
  prior written permission.

This software is provided by the copyright holders and contributors “as is”
and any express or implied warranties, including, but not limited to, the
implied warranties of merchantability and fitness for a particular purpose
are disclaimed. In no event shall the copyright owner or contributors be
liable for any direct, indirect, incidental, special, exemplary, or
consequential damages (including, but not limited to, procurement of
substitute goods or services; loss of use, data, or profits; or business
interruption) however caused and on any theory of liability, whether in
contract, strict liability, or tort (including negligence or otherwise)
arising in any way out of the use of this software, even if advised of the
possibility of such damage.
